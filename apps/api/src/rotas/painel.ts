import {
  agenda,
  alertas,
  atrasos,
  comoConexaoDoBoss,
  conversas,
  fila,
  pacientes,
  procedimentos,
  withClinic,
  type Db,
  type Trx,
} from '@fliqo/db';
import { FILA_ATRASOS } from '@fliqo/db/fila';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { autenticar, membroDaClinica, type Usuario } from '../auth';

export interface ContextoPainel {
  db: Db;
  segredoJwt: Uint8Array;
  boss: PgBoss;
}

/** Cabeçalho que diz em qual clínica a pessoa quer trabalhar. É pedido, não credencial. */
const CABECALHO_CLINICA = 'x-clinica';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O que `comUsuario` devolve.
 *
 * Precisa ser explícito: se o retorno fosse `T | undefined`, "já respondi 403" e
 * "a função devolveu undefined" seriam a mesma coisa, e uma rota cujo repositório
 * não acha a linha responderia como se o acesso tivesse sido negado.
 */
type SaidaPainel<T> = { respondido: true } | { respondido: false; valor: T };

/**
 * Roda `fn` já autenticado e dentro da clínica, ou responde 401/403.
 *
 * A ordem importa: a transação abre na clínica PEDIDA, e a primeira coisa que
 * acontece dentro dela é confirmar que a pessoa é membro. Nada é lido antes disso.
 * Pedir outra clínica não adianta: a RLS já limitou clinic_members ao tenant da
 * transação, então a consulta não acha a pessoa e o acesso é negado.
 */
async function comUsuario<T>(
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

const Periodo = z.object({
  de: z.coerce.date(),
  ate: z.coerce.date(),
  profissionalId: z.string().uuid().optional(),
});
const Marcacao = z.object({
  profissionalId: z.string().uuid(),
  pacienteId: z.string().uuid(),
  procedimentoId: z.string().uuid(),
  inicio: z.coerce.date(),
});
const Remarcacao = z.object({
  novoInicio: z.coerce.date(),
  novoProfissionalId: z.string().uuid().optional(),
});
const Cancelamento = z.object({ motivo: z.string().min(1).max(200) });
const NovaEspera = z.object({
  pacienteId: z.string().uuid(),
  procedimentoId: z.string().uuid(),
  profissionalId: z.string().uuid().optional(),
  janelaInicio: z.coerce.date(),
  janelaFim: z.coerce.date(),
  prioridade: z.number().int().min(0).max(3).optional(),
});
const Consentimento = z.object({ em: z.coerce.date().optional() });

export function registrarPainel(app: FastifyInstance, ctx: ContextoPainel): void {
  app.get('/api/agenda', async (req, reply) => {
    const q = Periodo.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ erro: 'periodo_invalido' });
    const r = await comUsuario(ctx, req, reply, (trx) =>
      agenda.listarPorPeriodo(trx, q.data.de, q.data.ate, q.data.profissionalId),
    );
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/agenda', async (req, reply) => {
    const c = Marcacao.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const r = await comUsuario(ctx, req, reply, (trx) =>
      agenda.criar(trx, { ...c.data, origem: 'recepcao' }),
    );
    if (r.respondido) return reply;
    // Horário ocupado não é erro do servidor: é resposta de negócio.
    return r.valor.ok
      ? reply.code(201).send(r.valor.consulta)
      : reply.code(409).send({ erro: r.valor.motivo });
  });

  app.post('/api/agenda/:id/remarcar', async (req, reply) => {
    const c = Remarcacao.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const { id } = req.params as { id: string };
    const r = await comUsuario(ctx, req, reply, (trx) =>
      agenda.remarcar(trx, id, c.data.novoInicio, c.data.novoProfissionalId),
    );
    if (r.respondido) return reply;
    return r.valor.ok
      ? reply.send(r.valor.consulta)
      : reply.code(409).send({ erro: r.valor.motivo });
  });

  app.post('/api/agenda/:id/cancelar', async (req, reply) => {
    const c = Cancelamento.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const { id } = req.params as { id: string };
    const r = await comUsuario(ctx, req, reply, (trx) => agenda.cancelar(trx, id, c.data.motivo));
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'consulta_nao_encontrada' });
  });

  /**
   * Os três toques da tela Hoje: chegou, iniciar, finalizar.
   *
   * Um toque cada, sem formulário: quem usa isto é a recepção entre um paciente
   * e outro, ou o profissional no celular com luva na mão. O horário é o do
   * servidor, não vem do cliente — senão um relógio errado no balcão
   * bagunçaria a projeção do dia inteiro.
   *
   * Cada toque enfileira a varredura de atrasos NA MESMA TRANSAÇÃO: ou o
   * horário fica gravado e a varredura acontece, ou nenhum dos dois.
   */
  const toques = [
    { caminho: 'chegou', registrar: atrasos.registrarChegada },
    { caminho: 'iniciar', registrar: atrasos.registrarInicio },
    { caminho: 'finalizar', registrar: atrasos.registrarFim },
  ] as const;

  for (const toque of toques) {
    app.post(`/api/agenda/:id/${toque.caminho}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

      const r = await comUsuario(ctx, req, reply, async (trx, u) => {
        const consulta = await toque.registrar(trx, id, new Date());
        if (!consulta) return undefined;
        await ctx.boss.send({
          name: FILA_ATRASOS,
          data: { clinicId: u.clinicId },
          // Uma varredura por clínica de cada vez: dez toques seguidos na
          // recepção não viram dez varreduras em paralelo.
          options: { singletonKey: u.clinicId, db: comoConexaoDoBoss(trx) },
        });
        return consulta;
      });
      if (r.respondido) return reply;
      return r.valor
        ? reply.send(r.valor)
        : reply.code(404).send({ erro: 'consulta_nao_encontrada' });
    });
  }

  app.get('/api/pacientes', async (req, reply) => {
    const { telefone } = req.query as { telefone?: string };
    const r = await comUsuario(ctx, req, reply, async (trx) => {
      if (telefone === undefined) return [];
      const p = await pacientes.porTelefone(trx, telefone);
      return p ? [p] : [];
    });
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/pacientes/:id/consentimento', async (req, reply) => {
    const c = Consentimento.safeParse(req.body ?? {});
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const { id } = req.params as { id: string };
    // A recepção marcando no cadastro é um dos dois caminhos válidos de consentimento.
    const r = await comUsuario(ctx, req, reply, (trx) =>
      pacientes.registrarConsentimento(trx, id, c.data.em ?? new Date()),
    );
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(409).send({ erro: 'consentimento_ja_registrado' });
  });

  app.get('/api/procedimentos', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, (trx) => procedimentos.listarAtivos(trx));
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.get('/api/fila', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, (trx) =>
      trx
        .selectFrom('app.waitlist_entries')
        .selectAll()
        .where('status', '=', 'aguardando')
        .orderBy('priority_level', 'desc')
        .orderBy('created_at')
        .execute(),
    );
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/fila', async (req, reply) => {
    const c = NovaEspera.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const { profissionalId, prioridade, ...resto } = c.data;
    const r = await comUsuario(ctx, req, reply, (trx, u) =>
      fila.entrar(trx, u.clinicId, {
        ...resto,
        ...(profissionalId === undefined ? {} : { profissionalId }),
        ...(prioridade === undefined ? {} : { prioridade }),
      }),
    );
    if (r.respondido) return reply;
    return reply.code(201).send(r.valor);
  });

  app.get('/api/conversas', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, (trx) =>
      trx
        .selectFrom('app.conversations')
        .selectAll()
        .orderBy('last_inbound_at', 'desc')
        .limit(100)
        .execute(),
    );
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.get('/api/conversas/:id/mensagens', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await comUsuario(ctx, req, reply, (trx) => conversas.ultimasMensagens(trx, id, 50));
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/conversas/:id/assumir', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await comUsuario(ctx, req, reply, (trx) =>
      conversas.definirModo(trx, id, 'humano', 'assumida pelo painel'),
    );
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'conversa_nao_encontrada' });
  });

  app.post('/api/conversas/:id/devolver', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await comUsuario(ctx, req, reply, (trx) => conversas.definirModo(trx, id, 'ia'));
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'conversa_nao_encontrada' });
  });

  app.get('/api/alertas', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, (trx) => alertas.abertos(trx));
    return r.respondido ? reply : reply.send(r.valor);
  });
}
