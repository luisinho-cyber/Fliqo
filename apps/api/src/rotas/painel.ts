import {
  acoes,
  agenda,
  alertas,
  atrasos,
  comoConexaoDoBoss,
  fila,
  pacientes,
  procedimentos,
} from '@fliqo/db';
import { FILA_ATRASOS, FILA_OFERTA } from '@fliqo/db/fila';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { comUsuario, UUID, type ContextoPainel } from './contexto';

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
const Vaga = z.object({
  profissionalId: z.string().uuid(),
  inicio: z.coerce.date(),
  fim: z.coerce.date(),
});

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

  /**
   * Cancelar pelo painel.
   *
   * O horário abriu, então a fila precisa ser chamada — igual ao cancelamento
   * pelo botão do WhatsApp e ao da assistente. Este caminho, que é o que a
   * recepção mais usa, ficou de fora até a invariante de
   * apps/worker/tests/cancelamento.test.ts enumerar os quatro e acusar.
   *
   * O enfileiramento vai na MESMA transação do cancelamento: ou o horário fica
   * livre e a fila é chamada, ou nenhum dos dois. Cancelar e não chamar ninguém
   * é a promessa do produto quebrada em silêncio.
   */
  app.post('/api/agenda/:id/cancelar', async (req, reply) => {
    const c = Cancelamento.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    const { id } = req.params as { id: string };

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      const cancelada = await agenda.cancelar(trx, id, c.data.motivo);
      if (!cancelada) return undefined;

      // singletonKey na vaga: cancelar duas vezes não manda a mesma vaga para as
      // mesmas pessoas da fila duas vezes.
      const chave = `${u.clinicId}:${cancelada.professional_id}:${cancelada.starts_at.toISOString()}`;
      await ctx.boss.send({
        name: FILA_OFERTA,
        data: {
          clinicId: u.clinicId,
          profissionalId: cancelada.professional_id,
          inicio: cancelada.starts_at.toISOString(),
          fim: cancelada.ends_at.toISOString(),
        },
        options: { singletonKey: chave, db: comoConexaoDoBoss(trx) },
      });
      return cancelada;
    });

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

  /**
   * O telefone inteiro de UM paciente, por pedido explícito.
   *
   * É a contrapartida da regra: nenhuma listagem devolve o número inteiro, e ele
   * sai daqui — de um endpoint por paciente, que é o que o botão "Ligar" chama.
   * Tocar nele é um ato deliberado (DESIGN.md), e é por isso que ele existe
   * separado em vez de o número viajar em toda lista.
   *
   * Quando houver log de auditoria, é aqui que a linha "quem revelou o telefone de
   * quem, e quando" vai morar — anotado em docs/OPERACAO.md. Não agora.
   */
  app.get('/api/pacientes/:id/telefone', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, (trx) => pacientes.porId(trx, id));
    if (r.respondido) return reply;
    return r.valor
      ? reply.send({ telefone: r.valor.phone_e164 })
      : reply.code(404).send({ erro: 'paciente_nao_encontrado' });
  });

  /**
   * "Enviar confirmação agora": devolve uma ação descartada para a fila.
   *
   * Não reimplementa o envio — só volta a ação para `pendente` com vencimento
   * agora, e o worker refaz o caminho inteiro, checagem de pertinência incluída.
   * Se a afirmação do template tiver vencido nesse meio-tempo, ela volta para
   * `sem_proposito` em vez de mandar mensagem falsa.
   */
  app.post('/api/acoes/:id/reenviar', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, (trx) => acoes.reenfileirar(trx, id));
    if (r.respondido) return reply;
    return r.valor
      ? reply.send({ ok: true })
      : reply.code(404).send({ erro: 'acao_nao_descartada' });
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

  /**
   * Oferecer um horário vago à lista de espera.
   *
   * O painel PEDE; quem executa é o worker, que é quem fala com o WhatsApp.
   * A fila é `stately` com singletonKey na vaga: a recepção clicando duas vezes
   * no mesmo horário não abre duas rodadas — e duas rodadas mandariam oferta em
   * dobro para as mesmas pessoas da fila.
   *
   * O clinicId vai do servidor, da transação já autenticada. O corpo do pedido
   * nunca diz de qual clínica é a vaga.
   */
  app.post('/api/fila/oferecer', async (req, reply) => {
    const c = Vaga.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });
    if (c.data.fim <= c.data.inicio) return reply.code(400).send({ erro: 'intervalo_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      // O profissional precisa ser desta clínica: a RLS não deixa a consulta
      // achar profissional de outra, então não achar é resposta de negócio.
      const prof = await trx
        .selectFrom('app.professionals')
        .select(['id'])
        .where('id', '=', c.data.profissionalId)
        .executeTakeFirst();
      if (!prof) return { ok: false as const };

      const chave = `${u.clinicId}:${c.data.profissionalId}:${c.data.inicio.toISOString()}`;
      await ctx.boss.send({
        name: FILA_OFERTA,
        data: {
          clinicId: u.clinicId,
          profissionalId: c.data.profissionalId,
          inicio: c.data.inicio.toISOString(),
          fim: c.data.fim.toISOString(),
        },
        options: { singletonKey: chave, db: comoConexaoDoBoss(trx) },
      });
      return { ok: true as const };
    });
    if (r.respondido) return reply;
    return r.valor.ok
      ? reply.code(202).send({ ok: true })
      : reply.code(404).send({ erro: 'profissional_nao_encontrado' });
  });

  app.get('/api/alertas', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, (trx) => alertas.abertos(trx));
    return r.respondido ? reply : reply.send(r.valor);
  });

  /** A única ação de cada linha da lista de decisões: resolvido, some da tela. */
  app.post('/api/alertas/:id/resolver', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const r = await comUsuario(ctx, req, reply, (trx) => alertas.resolver(trx, id));
    if (r.respondido) return reply;
    // 404 também para o alerta que outra pessoa já resolveu: do ponto de vista
    // de quem clicou agora, não há mais o que resolver.
    return r.valor ? reply.send(r.valor) : reply.code(404).send({ erro: 'alerta_nao_encontrado' });
  });
}
