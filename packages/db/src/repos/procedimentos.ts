import { readFileSync } from 'node:fs';
import type { Selectable } from 'kysely';
import { ehViolacaoDeUnicidade } from '../erros';
import type { TabelaProcedimentos } from '../schema';
import { sobSavepoint, type Trx } from '../withClinic';

export type Procedimento = Selectable<TabelaProcedimentos>;

export async function porId(trx: Trx, id: string): Promise<Procedimento | undefined> {
  return trx.selectFrom('app.procedures').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function listarAtivos(trx: Trx): Promise<Procedimento[]> {
  return trx
    .selectFrom('app.procedures')
    .selectAll()
    .where('active', '=', true)
    .orderBy('name')
    .execute();
}

/**
 * Ajusta a duração na agenda. Só vale para os próximos agendamentos: consultas já
 * marcadas guardam a própria duração em starts_at/ends_at e não são tocadas.
 *
 * O autor é obrigatório no tipo, e não opcional com default nulo: o carimbo
 * (0011) existe para responder "quem encurtou a limpeza?", e parâmetro que pode
 * ser omitido é parâmetro que vai ser omitido. Quem ajusta é sempre uma pessoa
 * autenticada — não há ajuste automático de cadastro.
 */
export async function ajustarDuracao(
  trx: Trx,
  id: string,
  duracaoMinutos: number,
  autorUserId: string,
  em: Date,
): Promise<Procedimento | undefined> {
  return trx
    .updateTable('app.procedures')
    .set({
      duration_minutes: duracaoMinutos,
      duration_updated_by: autorUserId,
      duration_updated_at: em,
      updated_at: em,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Todos, ativos e inativos, para a tela de cadastro.
 *
 * `listarAtivos` continua existindo e é o que a agenda usa: oferecer procedimento
 * inativo para marcar seria oferecer o que a clínica decidiu não fazer mais.
 */
export async function listarTodos(trx: Trx): Promise<Procedimento[]> {
  return (
    trx
      .selectFrom('app.procedures')
      .selectAll()
      // Inativo por último, e depois por nome: a tela é de trabalho, e o que está em uso
      // tem de estar em cima.
      .orderBy('active', 'desc')
      .orderBy('name')
      .execute()
  );
}

/**
 * Pede retorno, e em quantos dias — num valor só.
 *
 * Dois campos independentes (`exigeRetorno` e `diasAteRetorno`) permitiriam "pede retorno
 * em nada" e "não pede retorno, em 30 dias", que são dois estados que a tela teria de
 * decidir como mostrar e que um relatório futuro contaria errado. Aqui o estado inválido
 * não se escreve, e o check `procedures_followup_check` (0014) diz o mesmo no banco.
 */
export type Retorno = { exige: false } | { exige: true; emDias: number };

/** As duas colunas, a partir do valor único. O único lugar que faz essa tradução. */
function colunasDoRetorno(r: Retorno): {
  requires_followup: boolean;
  followup_days: number | null;
} {
  return r.exige
    ? { requires_followup: true, followup_days: r.emDias }
    : { requires_followup: false, followup_days: null };
}

/** O caminho de volta, para a tela e para a API. */
export function retornoDe(p: Procedimento): Retorno {
  return p.requires_followup && p.followup_days !== null
    ? { exige: true, emDias: p.followup_days }
    : { exige: false };
}

export interface ProcedimentoNovo {
  nome: string;
  duracaoMinutos: number;
  precoCents: number;
  retorno: Retorno;
}

export type ResultadoDeCadastro =
  { ok: true; procedimento: Procedimento } | { ok: false; motivo: 'nome_repetido' };

/**
 * Cadastra, ou devolve `nome_repetido`.
 *
 * Não pergunta antes se o nome existe: quem decide é o índice único da 0013, e o 23505
 * é traduzido aqui. É o mesmo desenho do `no_double_booking` e pela mesma razão — entre
 * o SELECT e o INSERT a outra recepcionista cadastra.
 *
 * O savepoint existe porque violação de constraint aborta a transação inteira no
 * Postgres: sem ele, um nome repetido levaria embora tudo que já aconteceu nela.
 */
export async function criar(
  trx: Trx,
  clinicId: string,
  p: ProcedimentoNovo,
): Promise<ResultadoDeCadastro> {
  const criado = await sobSavepoint(
    trx,
    'cadastrar_procedimento',
    () =>
      trx
        .insertInto('app.procedures')
        .values({
          clinic_id: clinicId,
          name: p.nome,
          duration_minutes: p.duracaoMinutos,
          price_cents: p.precoCents,
          ...colunasDoRetorno(p.retorno),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    ehViolacaoDeUnicidade,
  );
  return criado === undefined
    ? { ok: false, motivo: 'nome_repetido' }
    : { ok: true, procedimento: criado };
}

/**
 * `| undefined` explícito em cada campo, e não só o `?`.
 *
 * Com `exactOptionalPropertyTypes`, "ausente" e "presente valendo undefined" são tipos
 * diferentes — e o Zod com `.partial()` produz o segundo. Aceitar os dois aqui é o que
 * permite a rota repassar o que o Zod devolveu sem reconstruir o objeto campo a campo,
 * que é onde um campo novo seria esquecido.
 */
export interface MudancaNoProcedimento {
  nome?: string | undefined;
  duracaoMinutos?: number | undefined;
  precoCents?: number | undefined;
  retorno?: Retorno | undefined;
}

/**
 * Edita o cadastro. Preço novo vale para consulta NOVA.
 *
 * Isto não é uma escolha desta função: é o que `agenda.criar` já faz, copiando o preço
 * do procedimento para a consulta no momento da marcação, e o que `agenda.remarcar` já
 * faz, carregando o preço da consulta antiga em vez de reler o cadastro. Consulta que já
 * aconteceu guarda o preço do dia em que foi marcada, e nada aqui a alcança. Não há um
 * segundo caminho para manter.
 *
 * A duração passa pelo mesmo carimbo de autor da 0011 quando muda, porque é a mesma
 * mudança: "quem encurtou a limpeza?" tem de ter resposta.
 */
export async function atualizar(
  trx: Trx,
  id: string,
  mudanca: MudancaNoProcedimento,
  autorUserId: string,
  em: Date,
): Promise<ResultadoDeCadastro | { ok: false; motivo: 'nao_encontrado' }> {
  const atual = await porId(trx, id);
  if (atual === undefined) return { ok: false, motivo: 'nao_encontrado' };

  const mudouDuracao =
    mudanca.duracaoMinutos !== undefined && mudanca.duracaoMinutos !== atual.duration_minutes;

  const salvo = await sobSavepoint(
    trx,
    'editar_procedimento',
    () =>
      trx
        .updateTable('app.procedures')
        .set({
          ...(mudanca.nome === undefined ? {} : { name: mudanca.nome }),
          ...(mudanca.duracaoMinutos === undefined
            ? {}
            : { duration_minutes: mudanca.duracaoMinutos }),
          ...(mudanca.precoCents === undefined ? {} : { price_cents: mudanca.precoCents }),
          ...(mudanca.retorno === undefined ? {} : colunasDoRetorno(mudanca.retorno)),
          ...(mudouDuracao ? { duration_updated_by: autorUserId, duration_updated_at: em } : {}),
          updated_at: em,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    ehViolacaoDeUnicidade,
  );

  return salvo === undefined
    ? { ok: false, motivo: 'nome_repetido' }
    : { ok: true, procedimento: salvo };
}

/**
 * Liga e desliga. NUNCA apaga.
 *
 * Consulta antiga tem chave estrangeira para o procedimento, e apagar reescreveria o
 * passado: o histórico de um paciente passaria a apontar para nada, e o Caixa de um mês
 * fechado mudaria de valor. Inativar tira da agenda e deixa o histórico inteiro.
 */
export async function definirAtivo(
  trx: Trx,
  id: string,
  ativo: boolean,
  em: Date,
): Promise<Procedimento | undefined> {
  return trx
    .updateTable('app.procedures')
    .set({ active: ativo, updated_at: em })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/** Quantas consultas apontam para este procedimento. A tela usa para explicar por que não há apagar. */
export async function consultasQueApontam(trx: Trx, id: string): Promise<number> {
  const r = await trx
    .selectFrom('app.appointments')
    .select((eb) => eb.fn.countAll<string>().as('quantas'))
    .where('procedure_id', '=', id)
    .executeTakeFirstOrThrow();
  return Number(r.quantas);
}

/**
 * O catálogo inicial, lido de packages/db/seeds/procedimentos.json.
 *
 * Existe porque clínica nova abre a tela de cadastro vazia e tem de digitar quatorze
 * procedimentos antes de marcar a primeira consulta — e é nesse ponto que ela desiste e
 * volta para a agenda de papel. Preço e duração são ponto de partida, e a tela existe
 * justamente para corrigi-los.
 */
export interface CatalogoInicial {
  odontologia: ProcedimentoNovo[];
  estetica: ProcedimentoNovo[];
}

export function lerCatalogoInicial(): CatalogoInicial {
  const caminho = new URL('../../seeds/procedimentos.json', import.meta.url);
  const bruto = JSON.parse(readFileSync(caminho, 'utf8')) as CatalogoInicial;
  return { odontologia: bruto.odontologia, estetica: bruto.estetica };
}

export interface ResultadoDaSemeadura {
  criados: string[];
  /** Os que já existiam, por nome. Semear duas vezes não duplica nem estoura. */
  pulados: string[];
}

/**
 * Semeia o catálogo numa clínica, pulando o que já existe.
 *
 * Idempotente de propósito, e não por conveniência: a semeadura acontece na criação da
 * clínica, e criação de clínica é o tipo de fluxo que alguém repete depois de um erro de
 * rede. Sem o `nome_repetido` tratado, a segunda tentativa estouraria no índice da 0013 e
 * deixaria a clínica com metade do catálogo.
 *
 * Roda dentro de `withClinic`, como todo o resto: a RLS é quem garante que o catálogo
 * entra na clínica certa, e não um `clinic_id` que quem chamou escolheu.
 */
export async function semear(
  trx: Trx,
  clinicId: string,
  lista: readonly ProcedimentoNovo[],
): Promise<ResultadoDaSemeadura> {
  const saida: ResultadoDaSemeadura = { criados: [], pulados: [] };
  for (const p of lista) {
    const r = await criar(trx, clinicId, p);
    if (r.ok) saida.criados.push(p.nome);
    else saida.pulados.push(p.nome);
  }
  return saida;
}
