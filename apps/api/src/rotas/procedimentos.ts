import { procedimentos, type PapelMembro, type Trx } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { comUsuario, UUID, type ContextoPainel } from './contexto';

/**
 * Cadastro de procedimentos da clínica.
 *
 * Existe porque não havia onde digitar preço em lugar nenhum da Fliqo: o Caixa contava
 * "N procedimentos sem preço cadastrado" e não dava o caminho para resolver.
 *
 * NÃO passa por `comRecurso`. O preço só importa para o financeiro, que o modo convidado
 * desliga — mas a DURAÇÃO alimenta a Linha do Dia e a Pontualidade, que funcionam em
 * qualquer modo. Esconder esta tela no modo convidado tiraria da clínica o único lugar de
 * corrigir a duração que desloca o dia dela.
 */

/** Quem edita o cadastro. A recepção lê: ela precisa saber a duração para marcar. */
const PAPEIS_QUE_EDITAM: readonly PapelMembro[] = ['dono', 'financeiro'];

/**
 * Os limites vêm dos checks da 0001, repetidos aqui para a recusa chegar em português
 * antes do banco: `duration_minutes between 5 and 600`, `price_cents >= 0`.
 *
 * Teto de preço de um procedimento: cem mil reais. Não é um limite de negócio, é a
 * guarda contra o dedo escorregando no zero — um implante de R$ 3.500 digitado como
 * 350000000 centavos entraria calado e apareceria como três milhões no Caixa.
 */
const TETO_DE_PRECO_CENTS = 10_000_000;

const Cadastro = z.object({
  nome: z.string().trim().min(2).max(120),
  duracaoMinutos: z.number().int().min(5).max(600),
  precoCents: z.number().int().min(0).max(TETO_DE_PRECO_CENTS),
});

/** Na edição todo campo é opcional, mas pelo menos um tem de vir. */
const Edicao = Cadastro.partial().refine((m) => Object.keys(m).length > 0, {
  message: 'nada para mudar',
});

const Ativacao = z.object({ ativo: z.boolean() });

export interface ProcedimentoNaTela {
  id: string;
  nome: string;
  duracaoMinutos: number;
  precoCents: number;
  ativo: boolean;
  /** Veio da importação de agenda do outro sistema (0012). */
  daImportacao: boolean;
  /**
   * Preço que ninguém cadastrou — não é cortesia.
   *
   * É a MESMA pergunta que o Caixa faz (`source = 'importado'` e preço zero), e de
   * propósito: se as duas telas discordassem, a clínica cadastraria o preço aqui e o
   * Caixa continuaria reclamando, ou o contrário.
   */
  semPreco: boolean;
  /** Quantas consultas apontam para ele. É por isso que não há apagar. */
  consultas: number;
}

export interface RespostaProcedimentos {
  podeEditar: boolean;
  procedimentos: ProcedimentoNaTela[];
  /** Quantos estão sem preço. O aviso do topo da tela sai daqui. */
  semPreco: number;
}

export function registrarProcedimentos(app: FastifyInstance, ctx: ContextoPainel): void {
  app.get('/api/procedimentos', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, async (trx, u) => montar(trx, u.papel));
    return r.respondido ? reply : reply.send(r.valor);
  });

  app.post('/api/procedimentos', async (req, reply) => {
    const pedido = Cadastro.safeParse(req.body);
    if (!pedido.success) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (!PAPEIS_QUE_EDITAM.includes(u.papel)) return { negado: true as const };
      return {
        negado: false as const,
        valor: await procedimentos.criar(trx, u.clinicId, pedido.data),
      };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'nao_edita_procedimento' });
    if (!r.valor.valor.ok) {
      // 409 e não 400: o pedido está bem formado, o nome é que já existe. A tela escreve
      // "já existe um procedimento com esse nome" e oferece reativar, se estiver inativo.
      return reply.code(409).send({ erro: r.valor.valor.motivo });
    }
    return reply.code(201).send({ id: r.valor.valor.procedimento.id });
  });

  app.post('/api/procedimentos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const pedido = Edicao.safeParse(req.body);
    if (!pedido.success) return reply.code(400).send({ erro: 'pedido_invalido' });

    const agora = new Date();
    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (!PAPEIS_QUE_EDITAM.includes(u.papel)) return { negado: true as const };
      return {
        negado: false as const,
        valor: await procedimentos.atualizar(trx, id, pedido.data, u.userId, agora),
      };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'nao_edita_procedimento' });
    const saida = r.valor.valor;
    if (saida.ok) return reply.send({ ok: true });
    // `nao_encontrado` é 404: para esta clínica o procedimento de outra não existe.
    return reply.code(saida.motivo === 'nao_encontrado' ? 404 : 409).send({ erro: saida.motivo });
  });

  /**
   * Inativar e reativar. Não existe DELETE nesta rota, e a ausência é a regra:
   * consulta antiga aponta para o procedimento, e apagar reescreveria o passado.
   */
  app.post('/api/procedimentos/:id/ativo', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });
    const pedido = Ativacao.safeParse(req.body);
    if (!pedido.success) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (!PAPEIS_QUE_EDITAM.includes(u.papel)) return { negado: true as const };
      return {
        negado: false as const,
        valor: await procedimentos.definirAtivo(trx, id, pedido.data.ativo),
      };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'nao_edita_procedimento' });
    if (r.valor.valor === undefined) return reply.code(404).send({ erro: 'nao_encontrado' });
    return reply.send({ ok: true, ativo: r.valor.valor.active });
  });
}

async function montar(trx: Trx, papel: PapelMembro): Promise<RespostaProcedimentos> {
  const lista = await procedimentos.listarTodos(trx);
  const naTela: ProcedimentoNaTela[] = [];

  for (const p of lista) {
    const precoCents = Number(p.price_cents);
    naTela.push({
      id: p.id,
      nome: p.name,
      duracaoMinutos: p.duration_minutes,
      precoCents,
      ativo: p.active,
      daImportacao: p.source === 'importado',
      semPreco: p.source === 'importado' && precoCents === 0,
      consultas: await procedimentos.consultasQueApontam(trx, p.id),
    });
  }

  return {
    podeEditar: PAPEIS_QUE_EDITAM.includes(papel),
    procedimentos: naTela,
    semPreco: naTela.filter((p) => p.semPreco).length,
  };
}
