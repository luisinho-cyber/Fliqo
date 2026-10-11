import {
  percentualNoHorario,
  sugerirDuracaoPelaMediana,
  type SugestaoDeDuracao,
} from '@fliqo/core';
import { hoje, pontualidade, procedimentos, type Trx } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { comUsuario, UUID, type ContextoPainel } from './contexto';
import type { ClinicaNaTela } from './hoje';

/**
 * Pontualidade: o desfecho e a causa, na mesma resposta.
 *
 * A tela responde a uma pergunta só — "por que o dia desanda?" — e ela tem duas
 * metades que só fazem sentido juntas. A primeira é o sintoma por profissional. A
 * segunda é a causa candidata: procedimento cujo tempo real não é o cadastrado.
 * Separar em duas chamadas deixaria a tela mostrar um atraso médio ao lado de uma
 * medida de outro momento.
 *
 * Só o dono. Não é por segredo: é porque a tela compara pessoas por nome, e porque
 * a única ação que ela oferece muda o cadastro da clínica. O painel esconde a aba
 * de quem não é dono para não oferecer porta que bate na cara de quem abre — mas
 * quem decide é esta rota, dentro da transação.
 */

/** Janela padrão de leitura. A mesma dos 90 dias das views: técnica e equipamento mudam, e o ano passado não descreve o mês que vem. */
const JANELA_PADRAO_DIAS = 90;

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface ProfissionalNaPontualidade {
  id: string;
  nome: string;
  atendimentos: number;
  noHorario: number;
  /** `null` quando não houve atendimento: não é 0%, é "não há o que medir". */
  noHorarioPct: number | null;
  atrasoMedioMin: number;
}

export interface ProcedimentoNaPontualidade {
  id: string;
  nome: string;
  cadastradaMin: number;
  medianaMin: number;
  amostra: number;
  /** ISO, ou null para cadastro nunca ajustado — que é o caso da maioria. */
  ajustadaEm: string | null;
  sugestao: SugestaoDeDuracao;
}

export interface RespostaPontualidade {
  clinica: ClinicaNaTela;
  de: string;
  ate: string;
  profissionais: ProfissionalNaPontualidade[];
  procedimentos: ProcedimentoNaPontualidade[];
}

/** O que o card da tela Hoje precisa: só o que tem sugestão de verdade. */
export interface SugestaoNaHoje {
  procedimentoId: string;
  nome: string;
  cadastradaMin: number;
  novaDuracaoMin: number;
  medianaMin: number;
  amostra: number;
}

export async function sugestoesDeDuracao(trx: Trx): Promise<SugestaoNaHoje[]> {
  const medidas = await pontualidade.porProcedimento(trx);
  const out: SugestaoNaHoje[] = [];
  for (const m of medidas) {
    const s = sugerirDuracaoPelaMediana(
      { medianaMin: m.medianaMin, amostra: m.amostra },
      m.cadastradaMin,
    );
    if (!s.sugerir) continue;
    out.push({
      procedimentoId: m.procedure_id,
      nome: m.nome,
      cadastradaMin: s.cadastradaMin,
      novaDuracaoMin: s.novaDuracaoMin,
      medianaMin: s.medianaMin,
      amostra: s.amostra,
    });
  }
  // A maior divergência primeiro: é a que está custando mais minutos por dia.
  return out.sort(
    (a, b) =>
      Math.abs(b.novaDuracaoMin - b.cadastradaMin) - Math.abs(a.novaDuracaoMin - a.cadastradaMin),
  );
}

function diaIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function registrarPontualidade(app: FastifyInstance, ctx: ContextoPainel): void {
  app.get('/api/pontualidade', async (req, reply) => {
    const { de, ate } = req.query as { de?: string; ate?: string };
    if ((de !== undefined && !DATA_ISO.test(de)) || (ate !== undefined && !DATA_ISO.test(ate))) {
      return reply.code(400).send({ erro: 'data_invalida' });
    }

    const agora = new Date();
    const ateIso = ate ?? diaIso(agora);
    const deIso = de ?? diaIso(new Date(agora.getTime() - JANELA_PADRAO_DIAS * 86_400_000));
    if (deIso > ateIso) return reply.code(400).send({ erro: 'janela_invertida' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (u.papel !== 'dono') return { negado: true as const };
      return { negado: false as const, valor: await montar(trx, u.clinicId, deIso, ateIso) };
    });
    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'apenas_dono_ve_pontualidade' });
    return reply.send(r.valor.valor);
  });

  /**
   * Aceitar a sugestão. Um toque, e sem número no corpo.
   *
   * A rota NÃO recebe a duração: ela relê a medida e recalcula a mesma regra pura
   * que gerou a sugestão, e grava o que a regra devolver. Duas razões. A primeira é
   * que "um toque" não pode virar uma porta para escrever qualquer duração no
   * cadastro. A segunda é a corrida: entre a tela carregar e alguém clicar podem ter
   * entrado atendimentos, e o valor certo é o de agora, não o que o navegador viu.
   *
   * Sugestão que não existe mais responde 409 e não 404: o procedimento existe, o
   * que não existe é a divergência. A tela diz "a medida mudou, veja de novo".
   */
  app.post('/api/procedimentos/:id/duracao', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

    const agora = new Date();
    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (u.papel !== 'dono') return { negado: true as const, motivo: 'apenas_dono' as const };

      const medida = await pontualidade.doProcedimento(trx, id);
      // Sem medida: ou o procedimento não é desta clínica (a RLS não o achou), ou
      // nunca foi realizado. Nos dois casos não há sugestão para aceitar.
      if (medida === undefined) return { negado: false as const, aplicado: undefined };

      const s = sugerirDuracaoPelaMediana(
        { medianaMin: medida.medianaMin, amostra: medida.amostra },
        medida.cadastradaMin,
      );
      if (!s.sugerir) return { negado: false as const, aplicado: undefined, motivo: s.motivo };

      const p = await procedimentos.ajustarDuracao(trx, id, s.novaDuracaoMin, u.userId, agora);
      return { negado: false as const, aplicado: p === undefined ? undefined : s.novaDuracaoMin };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'apenas_dono_ajusta_duracao' });
    if (r.valor.aplicado === undefined) {
      return reply.code(409).send({ erro: 'sem_sugestao_para_este_procedimento' });
    }
    return reply.send({ ok: true, duracaoMin: r.valor.aplicado });
  });
}

async function montar(
  trx: Trx,
  clinicId: string,
  deIso: string,
  ateIso: string,
): Promise<RespostaPontualidade> {
  const clinica = await hoje.dadosDaClinica(trx, clinicId);
  const equipe = await pontualidade.porProfissional(trx, deIso, ateIso);
  const medidas = await pontualidade.porProcedimento(trx);

  return {
    clinica: { id: clinica.id, nome: clinica.nome },
    de: deIso,
    ate: ateIso,
    profissionais: equipe.map((p) => ({
      id: p.professional_id,
      nome: p.nome,
      atendimentos: p.atendimentos,
      noHorario: p.noHorario,
      noHorarioPct: percentualNoHorario(p),
      atrasoMedioMin: p.atrasoMedioMin,
    })),
    procedimentos: medidas.map((m) => ({
      id: m.procedure_id,
      nome: m.nome,
      cadastradaMin: m.cadastradaMin,
      medianaMin: m.medianaMin,
      amostra: m.amostra,
      ajustadaEm: m.ajustadaEm === null ? null : m.ajustadaEm.toISOString(),
      sugestao: sugerirDuracaoPelaMediana(
        { medianaMin: m.medianaMin, amostra: m.amostra },
        m.cadastradaMin,
      ),
    })),
  };
}
