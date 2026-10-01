import { recursoLiberado, type RecursoDoModoProprio } from '@fliqo/core';
import { hoje, withClinic, type Db, type Trx } from '@fliqo/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { autenticar, membroDaClinica, type Usuario } from '../auth';

export interface ContextoPainel {
  db: Db;
  segredoJwt: Uint8Array;
  boss: PgBoss;
}

/** Cabeçalho que diz em qual clínica a pessoa quer trabalhar. É pedido, não credencial. */
export const CABECALHO_CLINICA = 'x-clinica';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O que `comUsuario` devolve.
 *
 * Precisa ser explícito: se o retorno fosse `T | undefined`, "já respondi 403" e
 * "a função devolveu undefined" seriam a mesma coisa, e uma rota cujo repositório
 * não acha a linha responderia como se o acesso tivesse sido negado.
 */
export type SaidaPainel<T> = { respondido: true } | { respondido: false; valor: T };

/**
 * Roda `fn` já autenticado e dentro da clínica, ou responde 401/403.
 *
 * A ordem importa: a transação abre na clínica PEDIDA, e a primeira coisa que
 * acontece dentro dela é confirmar que a pessoa é membro. Nada é lido antes disso.
 * Pedir outra clínica não adianta: a RLS já limitou clinic_members ao tenant da
 * transação, então a consulta não acha a pessoa e o acesso é negado.
 */
/**
 * Roda `fn` só se o recurso existir no modo da clínica; 403 em modo convidado.
 *
 * Existe como embrulho de `comUsuario`, e não como condição dentro de cada rota,
 * porque a regra é a mesma para todas e porque a lista de recursos é enumerada num
 * lugar só (`RECURSOS_DO_MODO_PROPRIO`, em core/importacao.ts). Rota nova de
 * prontuário ou de financeiro passa por aqui ou não passa por nada — e um teste
 * exige os dois na lista.
 *
 * O 403 diz o motivo, porque a tela precisa escrever "estes dados vivem no outro
 * sistema" em vez de "acesso negado": não é falta de permissão, é a clínica tendo
 * dito onde está a verdade.
 */
export async function comRecurso<T>(
  recurso: RecursoDoModoProprio,
  ctx: ContextoPainel,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (trx: Trx, usuario: Usuario) => Promise<T>,
): Promise<SaidaPainel<T>> {
  const r = await comUsuario(ctx, req, reply, async (trx, usuario) => {
    const clinica = await hoje.dadosDaClinica(trx, usuario.clinicId);
    if (!recursoLiberado(recurso, clinica)) return { desligado: true as const };
    return { desligado: false as const, valor: await fn(trx, usuario) };
  });
  if (r.respondido) return { respondido: true };
  if (r.valor.desligado) {
    await reply.code(403).send({ erro: 'recurso_do_modo_proprio', recurso });
    return { respondido: true };
  }
  return { respondido: false, valor: r.valor.valor };
}

export async function comUsuario<T>(
  ctx: ContextoPainel,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (trx: Trx, usuario: Usuario) => Promise<T>,
): Promise<SaidaPainel<T>> {
  const auth = await autenticar(req.headers.authorization, ctx.segredoJwt);
  if (!auth.ok) {
    await reply.code(401).send({ erro: auth.motivo });
    return { respondido: true };
  }

  const clinicId = req.headers[CABECALHO_CLINICA];
  if (typeof clinicId !== 'string' || !UUID.test(clinicId)) {
    await reply.code(400).send({ erro: 'clinica_nao_informada' });
    return { respondido: true };
  }

  const saida = await withClinic(
    clinicId,
    async (trx) => {
      const papel = await membroDaClinica(trx, auth.userId);
      if (papel === undefined) return { negado: true as const };
      const valor = await fn(trx, { userId: auth.userId, clinicId, papel });
      return { negado: false as const, valor };
    },
    ctx.db,
  );

  if (saida.negado) {
    // 403 e não 404: a pessoa existe, o acesso é que não.
    await reply.code(403).send({ erro: 'nao_e_membro_da_clinica' });
    return { respondido: true };
  }
  return { respondido: false, valor: saida.valor };
}
