import type { LinhaDaAgenda, MotivoDeRecusa } from '@fliqo/core';
import { sql, type Selectable } from 'kysely';
import type { TabelaImportacoes, TabelaLinhasRecusadas } from '../schema';
import type { Trx } from '../withClinic';
import { acharOuCriarPorTelefone, NOME_A_CONFIRMAR } from './pacientes';

export type Importacao = Selectable<TabelaImportacoes>;
export type LinhaRecusada = Selectable<TabelaLinhasRecusadas>;

/**
 * Gravar a agenda importada.
 *
 * Três coisas que o banco decide e este arquivo só traduz:
 *
 * 1. **Paciente é achado pelo telefone normalizado**, por
 *    `pacientes.acharOuCriarPorTelefone` — o mesmo caminho do WhatsApp. É daí que
 *    sai a deduplicação com e sem nono dígito, sem uma segunda regra aqui.
 * 2. **Linha repetida e horário ocupado são coisas diferentes.** O insert usa
 *    `on conflict` com a CHAVE NATURAL declarada, e não `on conflict do nothing`
 *    puro: o `do nothing` sem alvo engole também violação de EXCLUDE no Postgres,
 *    e aí "esta consulta já estava aqui" e "este horário é de outro paciente"
 *    viram a mesma coisa em silêncio. Uma é reimportação (correta, nada mudou), a
 *    outra é recusa com motivo.
 * 3. **Cada linha num savepoint, do primeiro passo ao último.** Violação de
 *    constraint aborta a transação inteira no Postgres; sem savepoint, uma linha
 *    conflitante levaria embora as quinhentas que já tinham entrado. E o savepoint
 *    precisa abrir ANTES do primeiro passo da linha, não antes do insert da consulta:
 *    achar ou criar paciente e procedimento também viola constraint.
 */

export interface ResultadoDaLinha {
  entrou: boolean;
  repetida: boolean;
  motivo?: MotivoDeRecusa;
}

/**
 * Profissional e procedimento pelo NOME, criando o que não existe.
 *
 * Criar em vez de recusar porque no modo convidado o cadastro é do outro sistema:
 * recusar toda linha cujo nome de procedimento não bate com o nosso cadastro faria
 * a primeira importação de qualquer clínica falhar inteira, o que é o mesmo que não
 * ter a função.
 *
 * O preço nasce zero e a duração no padrão — e isso NÃO é um dado financeiro
 * inventado: é exatamente por causa disso que o modo convidado desliga o financeiro.
 * O procedimento criado assim guarda `source = 'importado'`, para que o Caixa possa
 * dizer "N procedimentos sem preço cadastrado" em vez de somar zero no dia em que a
 * clínica desligar a flag.
 */
const DURACAO_PADRAO_MIN = 30;

async function profissionalPorNome(trx: Trx, clinicId: string, nome: string): Promise<string> {
  const existente = await trx
    .selectFrom('app.professionals')
    .select(['id'])
    .where('name', '=', nome)
    .executeTakeFirst();
  if (existente !== undefined) return existente.id;

  const criado = await trx
    .insertInto('app.professionals')
    .values({ clinic_id: clinicId, name: nome })
    .returning('id')
    .executeTakeFirstOrThrow();
  return criado.id;
}

/** O procedimento como o índice único o vê: `(clinic_id, lower(name))`. */
interface ProcedimentoDaLinha {
  id: string;
  duracaoMin: number;
  precoCents: string;
}

type LinhaDeProcedimento = { id: string; duration_minutes: number; price_cents: string };

const doBanco = (l: LinhaDeProcedimento): ProcedimentoDaLinha => ({
  id: l.id,
  duracaoMin: l.duration_minutes,
  precoCents: l.price_cents,
});

/**
 * A busca é pela CHAVE DO ÍNDICE, `lower(name)`, e não por `name`.
 *
 * Procurar por `name = $1` com índice único em `lower(name)` é procurar por uma chave e
 * gravar por outra: planilha com "limpeza" numa clínica que já tem "Limpeza" não acha
 * nada, insere, e o banco recusa com 23505. O índice está certo — "Limpeza" e "limpeza"
 * são o mesmo procedimento para a clínica — e quem estava errada era a busca.
 */
async function porChaveDoIndice(trx: Trx, nome: string): Promise<ProcedimentoDaLinha | undefined> {
  const r = await sql<LinhaDeProcedimento>`
    select id, duration_minutes, price_cents
      from app.procedures
     where lower(name) = lower(${nome})
     limit 1
  `.execute(trx);
  const linha = r.rows[0];
  return linha === undefined ? undefined : doBanco(linha);
}

async function procedimentoPorNome(
  trx: Trx,
  clinicId: string,
  nome: string,
): Promise<ProcedimentoDaLinha> {
  const existente = await porChaveDoIndice(trx, nome);
  if (existente !== undefined) return existente;

  // `on conflict do nothing` porque a busca acima não é promessa: entre ela e este
  // insert a recepção pode cadastrar o mesmo nome pela tela. Quem perde a corrida não
  // recebe linha de volta e lê o cadastro de quem ganhou, em vez de estourar 23505 e
  // derrubar a planilha inteira.
  const criado = await sql<LinhaDeProcedimento>`
    insert into app.procedures
      (clinic_id, name, duration_minutes, price_cents, source)
    values
      -- A origem marcada: o preço zero não foi cadastrado por ninguém, e o Caixa
      -- precisa poder contar esses procedimentos em vez de somá-los. Sem isto, no dia
      -- em que a clínica desligar o modo convidado, a tela de dinheiro mente verde.
      (${clinicId}, ${nome}, ${DURACAO_PADRAO_MIN}, 0, 'importado')
    on conflict (clinic_id, lower(name)) do nothing
    returning id, duration_minutes, price_cents
  `.execute(trx);

  const linha = criado.rows[0];
  if (linha !== undefined) return doBanco(linha);

  const deQuemGanhou = await porChaveDoIndice(trx, nome);
  if (deQuemGanhou === undefined) {
    // Não existe caminho para cair aqui: o insert não gravou porque o nome já existia.
    throw new Error('o procedimento não entrou nem foi achado pela chave do índice');
  }
  return deQuemGanhou;
}

/** Conflito de constraint de exclusão: o horário é de outro paciente. */
const CONFLITO_DE_AGENDA = '23P01';

/**
 * Chave única violada. É erro ESPERADO desta rota desde que o nome do procedimento
 * passou a ser único por clínica (migração 0013) e o telefone do paciente é único
 * (`patients_clinic_id_phone_e164_key`): o cadastro pode mudar embaixo da planilha,
 * pela tela ou pelo WhatsApp, enquanto ela sobe.
 */
const CHAVE_DUPLICADA = '23505';

function codigoDoPostgres(erro: unknown): string | undefined {
  if (typeof erro !== 'object' || erro === null) return undefined;
  const codigo = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' ? codigo : undefined;
}

/**
 * Uma linha da planilha, inteira, dentro do savepoint.
 *
 * O SAVEPOINT COBRE TUDO QUE A LINHA FAZ, e antes não cobria: paciente, profissional e
 * procedimento eram achados ou criados ANTES dele. Violação de constraint aborta a
 * transação inteira no Postgres, então qualquer erro naqueles três passos escapava de
 * `gravarLinha` fora de savepoint nenhum e levava embora a importação toda — não a
 * linha. Nada precisa ficar de fora: não há passo da linha que deva sobreviver à
 * recusa dela.
 */
export async function gravarLinha(
  trx: Trx,
  clinicId: string,
  linha: LinhaDaAgenda,
  fuso: string,
): Promise<ResultadoDaLinha> {
  await trx.executeQuery(sql`savepoint linha_da_planilha`.compile(trx));
  try {
    const r = await gravarDentroDoSavepoint(trx, clinicId, linha, fuso);
    await trx.executeQuery(sql`release savepoint linha_da_planilha`.compile(trx));
    return r;
  } catch (erro) {
    await trx.executeQuery(sql`rollback to savepoint linha_da_planilha`.compile(trx));
    const codigo = codigoDoPostgres(erro);
    if (codigo === CONFLITO_DE_AGENDA) {
      return { entrou: false, repetida: false, motivo: 'horario_ocupado' };
    }
    if (codigo === CHAVE_DUPLICADA) {
      return { entrou: false, repetida: false, motivo: 'cadastro_em_conflito' };
    }
    throw erro;
  }
}

async function gravarDentroDoSavepoint(
  trx: Trx,
  clinicId: string,
  linha: LinhaDaAgenda,
  fuso: string,
): Promise<ResultadoDaLinha> {
  const achado = await acharOuCriarPorTelefone(trx, clinicId, linha.telefone, linha.paciente);
  if (!achado.ok) return { entrou: false, repetida: false, motivo: 'telefone_invalido' };

  // Paciente que entrou pelo WhatsApp antes de a agenda ser importada está gravado
  // como "a confirmar". A planilha do outro sistema tem o nome de verdade, e é a
  // fonte dele no modo convidado. Nome JÁ corrigido na Fliqo não é sobrescrito: a
  // recepção que arrumou não quer o arquivo desfazendo.
  if (!achado.novo && achado.paciente.name === NOME_A_CONFIRMAR) {
    await trx
      .updateTable('app.patients')
      .set({ name: linha.paciente })
      .where('id', '=', achado.paciente.id)
      .execute();
  }

  const profissionalId = await profissionalPorNome(trx, clinicId, linha.profissional);
  const proc = await procedimentoPorNome(trx, clinicId, linha.procedimento);

  // O horário local vira instante AQUI, com o fuso cadastrado da clínica:
  // "14:00" na planilha é 14h na clínica, e é o Postgres que sabe aplicar o
  // horário de verão daquela data sem biblioteca nenhuma.
  const r = await sql<{ id: string }>`
    insert into app.appointments
      (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
       price_cents, source)
    values (
      ${clinicId}, ${profissionalId}, ${achado.paciente.id}, ${proc.id},
      (${linha.inicioLocal}::timestamp at time zone ${fuso}),
      (${linha.inicioLocal}::timestamp at time zone ${fuso}) + make_interval(mins => ${proc.duracaoMin}),
      ${proc.precoCents}, 'importado')
    -- O predicado do índice vai no alvo porque ele é PARCIAL: sem ele o Postgres
    -- não infere qual índice usar. E o alvo é explícito porque "do nothing" sem
    -- alvo engole violação de EXCLUDE junto, misturando "já estava aqui" com
    -- "este horário é de outro paciente".
    on conflict (clinic_id, professional_id, starts_at, patient_id)
      where (source = 'importado') do nothing
    returning id
  `.execute(trx);

  // Nenhuma linha devolvida: a chave natural já existia. Reimportação, nada mudou.
  return r.rows.length === 0
    ? { entrou: false, repetida: true }
    : { entrou: true, repetida: false };
}

export interface Contas {
  total: number;
  entraram: number;
  repetidas: number;
  recusadas: number;
}

export async function registrarImportacao(
  trx: Trx,
  clinicId: string,
  o: { autorUserId: string; arquivo: string; contas: Contas },
): Promise<Importacao> {
  return trx
    .insertInto('app.schedule_imports')
    .values({
      clinic_id: clinicId,
      actor_user_id: o.autorUserId,
      file_name: o.arquivo,
      rows_total: o.contas.total,
      rows_imported: o.contas.entraram,
      rows_repeated: o.contas.repetidas,
      rows_rejected: o.contas.recusadas,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function registrarRecusas(
  trx: Trx,
  clinicId: string,
  importId: string,
  recusas: readonly { linha: number; motivo: MotivoDeRecusa; rotulo: string }[],
): Promise<void> {
  if (recusas.length === 0) return;
  await trx
    .insertInto('app.schedule_import_rows')
    .values(
      recusas.map((r) => ({
        clinic_id: clinicId,
        import_id: importId,
        line_number: r.linha,
        reason: r.motivo,
        label: r.rotulo.slice(0, 120),
      })),
    )
    .execute();
}

export async function listar(trx: Trx, limite = 20): Promise<Importacao[]> {
  return trx
    .selectFrom('app.schedule_imports')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limite)
    .execute();
}

export async function porId(trx: Trx, id: string): Promise<Importacao | undefined> {
  return trx.selectFrom('app.schedule_imports').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function recusasDaImportacao(trx: Trx, importId: string): Promise<LinhaRecusada[]> {
  return trx
    .selectFrom('app.schedule_import_rows')
    .selectAll()
    .where('import_id', '=', importId)
    .orderBy('line_number')
    .execute();
}

/** Consultas que vieram de planilha. Usada no teste e no relatório. */
export async function contarImportadas(trx: Trx): Promise<number> {
  const r = await trx
    .selectFrom('app.appointments')
    .select((eb) => eb.fn.countAll<string>().as('quantas'))
    .where('source', '=', 'importado')
    .executeTakeFirstOrThrow();
  return Number(r.quantas);
}
