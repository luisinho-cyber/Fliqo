import { conexao, withClinic, type Db, type Trx } from '@fliqo/db';
import { cifrar, OnboardingMeta } from '@fliqo/whatsapp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { autenticar, membroDaClinica } from '../auth';

export interface ContextoConexao {
  db: Db;
  segredoJwt: Uint8Array;
  onboarding: OnboardingMeta;
  chaveDoToken: Buffer;
}

const CABECALHO_CLINICA = 'x-clinica';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Saida<T> = { respondido: true } | { respondido: false; valor: T };

async function comUsuario<T>(
  ctx: ContextoConexao,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (trx: Trx, clinicId: string) => Promise<T>,
): Promise<Saida<T>> {
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
      // Ligar o WhatsApp da clínica é decisão de quem manda nela.
      if (papel !== 'dono') return { negado: true as const };
      return { negado: false as const, valor: await fn(trx, clinicId) };
    },
    ctx.db,
  );

  if (saida.negado) {
    await reply.code(403).send({ erro: 'apenas_dono_conecta_whatsapp' });
    return { respondido: true };
  }
  return { respondido: false, valor: saida.valor };
}

/**
 * O que o navegador devolve ao fim do Embedded Signup. O `codigo` sozinho não
 * vale nada: trocá-lo por token exige o segredo do app, que só o servidor tem.
 */
const PedidoDeConexao = z.object({
  codigo: z.string().min(1),
  wabaId: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
  // PIN de verificação em duas etapas do número, escolhido pela clínica.
  pin: z.string().regex(/^\d{6}$/, 'o PIN tem 6 dígitos'),
  coexistencia: z.boolean().default(true),
});

export function registrarConexao(app: FastifyInstance, ctx: ContextoConexao): void {
  app.get('/api/whatsapp/status', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, async (trx) => ({
      conexao: (await conexao.status(trx)) ?? null,
      eventos: await conexao.eventos(trx, 10),
    }));
    return r.respondido ? reply : reply.send(r.valor);
  });

  // Conectar e reconectar são a mesma operação: o número é o mesmo, o token é
  // novo. Duas rotas porque o painel mostra dois botões diferentes, e o evento
  // registrado precisa dizer qual dos dois foi.
  for (const [caminho, evento] of [
    ['/api/whatsapp/conectar', 'conectou'],
    ['/api/whatsapp/reconectar', 'reconectou'],
  ] as const) {
    app.post(caminho, async (req, reply) => {
      const c = PedidoDeConexao.safeParse(req.body);
      if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });

      // A troca com a Meta acontece FORA da transação: é chamada de rede, e
      // segurar uma transação aberta esperando a internet prende conexão do pool.
      const resultado = await ctx.onboarding.conectar({
        codigo: c.data.codigo,
        ...(c.data.wabaId === undefined ? {} : { wabaId: c.data.wabaId }),
        ...(c.data.phoneNumberId === undefined ? {} : { phoneNumberId: c.data.phoneNumberId }),
        pin: c.data.pin,
      });

      const r = await comUsuario(ctx, req, reply, async (trx, clinicId) => {
        if (!resultado.ok) {
          await conexao.registrarEvento(
            trx,
            clinicId,
            'falhou',
            undefined,
            `${resultado.motivo}: ${resultado.detalhe}`,
          );
          return { ok: false as const, motivo: resultado.motivo };
        }

        const { id } = await conexao.gravarConexao(trx, clinicId, {
          phoneNumberId: resultado.phoneNumberId,
          wabaId: resultado.wabaId,
          ...(resultado.telefoneExibicao === undefined
            ? {}
            : { telefoneExibicao: resultado.telefoneExibicao }),
          coexistencia: c.data.coexistencia,
          token: cifrar(resultado.token, ctx.chaveDoToken),
        });
        await conexao.registrarEvento(trx, clinicId, evento, id);

        // Devolve o status, que por construção não inclui o token.
        return { ok: true as const, conexao: await conexao.status(trx) };
      });

      if (r.respondido) return reply;
      return r.valor.ok
        ? reply.send(r.valor.conexao)
        : reply.code(502).send({ erro: r.valor.motivo });
    });
  }
}
