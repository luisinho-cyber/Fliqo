import { mascararTelefone } from '@fliqo/core';
import { PerfilClinicaSchema } from '@fliqo/ai';
import { agenda, conversas, ia, qualificacao, type Trx } from '@fliqo/db';
import type { FaixaDeOrcamento } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { comUsuario, UUID, type ContextoPainel } from './contexto';

/**
 * A caixa de entrada da clínica.
 *
 * Duas regras de privacidade moram aqui, e são as únicas coisas desta rota que
 * não são óbvias:
 *
 * 1. O conteúdo da mensagem do paciente aparece na TELA inteiro, porque é o
 *    trabalho da recepção. Ele nunca entra em log, métrica nem corpo de erro
 *    (CLAUDE.md, estilo de código). Por isso nada aqui loga corpo, e as
 *    mensagens de erro falam de id, nunca de conteúdo.
 * 2. O telefone sai mascarado na lista — que fica aberta no balcão, à vista de
 *    quem passa — e inteiro só na ficha, que alguém abriu de propósito.
 */

const Estado = z.enum(['humano', 'assistente', 'todas']);

const Qualificacao = z.object({
  interesse: z.string().max(200).nullable().optional(),
  faixaDeOrcamento: z
    .enum(['nao_informado', 'ate_1k', 'de_1k_a_3k', 'de_3k_a_10k', 'acima_10k'])
    .nullable()
    .optional(),
  observacao: z.string().max(1000).nullable().optional(),
});

export interface ItemDaCaixaApi {
  id: string;
  modo: 'ia' | 'humano';
  /** Por que a assistente parou. É o que a tela mostra como marcação. */
  motivoHandover: string | null;
  ultimaEntradaEm: string | null;
  paciente: string;
  telefoneMascarado: string;
  temConsentimento: boolean;
  ultimaMensagem: { corpo: string | null; autor: string; em: string } | null;
}

/** O que a assistente leu da conversa, derivado do que já existe. */
export interface QualificacaoApi {
  origem: { quem: 'paciente' | 'clinica' | 'desconhecida'; em: string | null };
  conveniosDaClinica: string[];
  urgencia: { nivel: 'alta' | 'normal'; motivo: string | null };
  interesse: string | null;
  faixaDeOrcamento: FaixaDeOrcamento | null;
  observacao: string | null;
  atualizadoEm: string | null;
}

export function registrarConversas(app: FastifyInstance, ctx: ContextoPainel): void {
  app.get('/api/conversas', async (req, reply) => {
    const q = Estado.safeParse((req.query as { estado?: string }).estado ?? 'todas');
    if (!q.success) return reply.code(400).send({ erro: 'estado_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx) => {
      const itens = await conversas.listarParaCaixaDeEntrada(trx, { estado: q.data });
      return itens.map((i): ItemDaCaixaApi => ({
        id: i.id,
        modo: i.modo,
        motivoHandover: i.motivoHandover,
        ultimaEntradaEm: i.ultimaEntradaEm?.toISOString() ?? null,
        paciente: i.paciente,
        // Mascarado: a lista fica aberta no balcão.
        telefoneMascarado: mascararTelefone(i.telefone),
        temConsentimento: i.consentimentoEm !== null,
        ultimaMensagem:
          i.ultimaMensagem === undefined
            ? null
            : {
                corpo: i.ultimaMensagem.corpo,
                autor: i.ultimaMensagem.autor,
                em: i.ultimaMensagem.em.toISOString(),
              },
      }));
    });
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.get('/api/conversas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx) => {
      const ficha = await conversas.ficha(trx, id);
      if (!ficha) return undefined;

      const proximas = await agenda.proximasDoPaciente(trx, ficha.paciente.id, new Date(), 5);
      return {
        id: ficha.conversa.id,
        modo: ficha.conversa.mode,
        motivoHandover: ficha.conversa.handover_reason,
        paciente: {
          id: ficha.paciente.id,
          nome: ficha.paciente.nome,
          // Inteiro: quem abriu a ficha foi ver esta pessoa de propósito.
          telefone: ficha.paciente.telefone,
          temConsentimento: ficha.paciente.consentimentoEm !== null,
        },
        proximasConsultas: proximas.map((c) => ({
          id: c.id,
          inicio: c.starts_at.toISOString(),
          status: c.status,
        })),
        qualificacao: await montarQualificacao(trx, id, ficha),
      };
    });
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'conversa_nao_encontrada' });
  });

  app.get('/api/conversas/:id/mensagens', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const r = await comUsuario(ctx, req, reply, (trx) => conversas.ultimasMensagens(trx, id, 50));
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/conversas/:id/assumir', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    // 'humano' é o que silencia a assistente naquela conversa: o worker lê este
    // modo antes de responder qualquer coisa.
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
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const r = await comUsuario(ctx, req, reply, (trx) => conversas.definirModo(trx, id, 'ia'));
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'conversa_nao_encontrada' });
  });

  app.post('/api/conversas/:id/qualificacao', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const c = Qualificacao.safeParse(req.body ?? {});
    if (!c.success) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      // A conversa precisa existir DENTRO desta clínica. Sem isto, gravar
      // aceitaria um id de conversa de outra clínica e a chave estrangeira
      // composta seria o único guarda — erro de banco em vez de 404.
      const existe = await conversas.porId(trx, id);
      if (!existe) return undefined;
      // O autor é o `sub` do JWT que a API verificou, nunca o que veio no corpo.
      return qualificacao.gravar(trx, u.clinicId, id, c.data, u.userId);
    });
    if (r.respondido) return reply;
    return r.valor
      ? reply.send(r.valor)
      : reply.code(404).send({ erro: 'conversa_nao_encontrada' });
  });
}

/**
 * A qualificação que a tela mostra: o que a recepção escreveu, mais o que dá
 * para derivar sem guardar cópia.
 */
async function montarQualificacao(
  trx: Trx,
  conversaId: string,
  ficha: NonNullable<Awaited<ReturnType<typeof conversas.ficha>>>,
): Promise<QualificacaoApi> {
  const salva = await qualificacao.ler(trx, conversaId);

  const perfil = await ia.perfilAtivo(trx);
  const lido = PerfilClinicaSchema.safeParse(perfil?.profile);

  // Alerta aberto da conversa é o sinal mais forte de urgência que existe: foi
  // uma proteção determinística que disparou, não uma impressão de alguém.
  const alerta = await trx
    .selectFrom('app.alerts')
    .select(['kind', 'severity', 'title'])
    .where('conversation_id', '=', conversaId)
    .where('resolved_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  const urgente = alerta?.severity === 'urgente';

  return {
    origem: {
      quem:
        ficha.primeira === undefined
          ? 'desconhecida'
          : ficha.primeira.direcao === 'entrada'
            ? 'paciente'
            : 'clinica',
      em: ficha.primeira?.em.toISOString() ?? null,
    },
    conveniosDaClinica: lido.success ? lido.data.politicas.convenios : [],
    urgencia: {
      nivel: urgente ? 'alta' : 'normal',
      motivo: alerta?.title ?? ficha.conversa.handover_reason,
    },
    interesse: salva?.interest ?? null,
    faixaDeOrcamento: salva?.budget_band ?? null,
    observacao: salva?.note ?? null,
    atualizadoEm: salva?.updated_at.toISOString() ?? null,
  };
}
