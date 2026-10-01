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
 * 3. **Cada linha num savepoint.** Violação de constraint aborta a transação
 *    inteira no Postgres; sem savepoint, uma linha conflitante levaria embora as
 *    quinhentas que já tinham entrado.
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
 * A duração real quem mede é a view da 0011, depois dos primeiros atendimentos.
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

async function procedimentoPorNome(
  trx: Trx,
  clinicId: string,
  nome: string,
): Promise<{ id: string; duracaoMin: number; precoCents: string }> {
  const existente = await trx
    .selectFrom('app.procedures')
    .select(['id', 'duration_minutes', 'price_cents'])
    .where('name', '=', nome)
    .executeTakeFirst();
  if (existente !== undefined) {
    return {
      id: existente.id,
      duracaoMin: existente.duration_minutes,
      precoCents: existente.price_cents,
    };
  }

  const criado = await trx
    .insertInto('app.procedures')
    .values({
      clinic_id: clinicId,
      name: nome,
      duration_minutes: DURACAO_PADRAO_MIN,
      price_cents: 0,
    })
    .returning(['id', 'duration_minutes', 'price_cents'])
    .executeTakeFirstOrThrow();
  return { id: criado.id, duracaoMin: criado.duration_minutes, precoCents: criado.price_cents };
}

/** O código do Postgres para violação de constraint de exclusão: horário ocupado. */
const CONFLITO_DE_AGENDA = '23P01';

export async function gravarLinha(
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

  await trx.executeQuery(sql`savepoint linha_da_planilha`.compile(trx));
  try {
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
      on conflict (clinic_id, professional_id, starts_at, patient_id) do nothing
      returning id
    `.execute(trx);

    await trx.executeQuery(sql`release savepoint linha_da_planilha`.compile(trx));
    // Nenhuma linha devolvida: a chave natural já existia. Reimportação, nada mudou.
    return r.rows.length === 0
      ? { entrou: false, repetida: true }
      : { entrou: true, repetida: false };
  } catch (erro) {
    await trx.executeQuery(sql`rollback to savepoint linha_da_planilha`.compile(trx));
    if (
      typeof erro === 'object' &&
      erro !== null &&
      (erro as { code?: string }).code === CONFLITO_DE_AGENDA
    ) {
      return { entrou: false, repetida: false, motivo: 'horario_ocupado' };
    }
    throw erro;
  }
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
