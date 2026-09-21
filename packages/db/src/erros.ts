/**
 * Erros do Postgres que são resposta de negócio, não bug.
 *
 * O conflito de agenda é decidido pelo banco (CLAUDE.md, regra 3): a constraint
 * `no_double_booking` recusa o INSERT e o código traduz. Nunca perguntamos antes
 * se o horário está livre — entre o SELECT e o INSERT outra pessoa marca.
 */

/** exclusion_violation — duas consultas no mesmo horário do mesmo profissional. */
const CONFLITO_DE_EXCLUSAO = '23P01';
/** unique_violation. */
const VIOLACAO_DE_UNICIDADE = '23505';

function codigo(erro: unknown): string | undefined {
  if (typeof erro !== 'object' || erro === null) return undefined;
  const c: unknown = (erro as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

export function ehConflitoDeHorario(erro: unknown): boolean {
  return codigo(erro) === CONFLITO_DE_EXCLUSAO;
}

export function ehViolacaoDeUnicidade(erro: unknown): boolean {
  return codigo(erro) === VIOLACAO_DE_UNICIDADE;
}
