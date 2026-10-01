import {
  dataNoFuso,
  formatBRL,
  noFuso,
  resumirCaixa,
  somarDias,
  type ResumoDoCaixa,
} from '@fliqo/core';
import { financeiro, hoje, type PapelMembro, type Trx } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { comRecurso, type ContextoPainel } from './contexto';
import type { ClinicaNaTela } from './hoje';

/**
 * O caixa do período: marcado × esperado × realizado.
 *
 * A rota não calcula nada. Ela lê as consultas do período, entrega a
 * `resumirCaixa` de packages/core e devolve o que voltou — porque regra sobre
 * dinheiro tem de ser testável sem banco, e porque a mesma regra alimenta a frase da
 * manchete e as duas tabelas, que não podem divergir entre si.
 *
 * Passa por `comRecurso('financeiro')`: clínica em modo convidado não tem caixa, e a
 * verdade desses dados está no outro sistema. A guarda é AQUI e não na tela — aba
 * escondida com rota aberta é uma porta sem tranca atrás de um cartaz.
 */

/** Quem vê o caixa. A recepção não vê o faturamento da clínica. */
const PAPEIS_DO_CAIXA: readonly PapelMembro[] = ['dono', 'financeiro'];

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Janela padrão: a semana corrente é o que o dono olha de manhã. */
const JANELA_PADRAO_DIAS = 7;

export interface LinhaNaTela {
  id: string;
  nome: string;
  consultas: number;
  marcadoCents: number;
  esperadoCents: number;
  realizadoCents: number;
}

export interface ProcedimentoSemPreco {
  id: string;
  nome: string;
}

export interface RespostaCaixa {
  clinica: ClinicaNaTela;
  de: string;
  ate: string;
  consultas: number;
  marcadoCents: number;
  esperadoCents: number;
  realizadoCents: number;
  /** A frase da manchete, montada no servidor para a tela não remontar dinheiro. */
  manchete: string;
  faltas: { quantidade: number; valorCents: number };
  semPreco: {
    consultas: number;
    procedimentos: ProcedimentoSemPreco[];
  };
  porProfissional: LinhaNaTela[];
  porProcedimento: LinhaNaTela[];
}

export function registrarCaixa(app: FastifyInstance, ctx: ContextoPainel): void {
  app.get('/api/caixa', async (req, reply) => {
    const { de, ate } = req.query as { de?: string; ate?: string };
    if ((de !== undefined && !DATA_ISO.test(de)) || (ate !== undefined && !DATA_ISO.test(ate))) {
      return reply.code(400).send({ erro: 'data_invalida' });
    }

    if (de !== undefined && ate !== undefined && de > ate) {
      return reply.code(400).send({ erro: 'janela_invertida' });
    }

    const agora = new Date();
    const r = await comRecurso('financeiro', ctx, req, reply, async (trx, u) => {
      if (!PAPEIS_DO_CAIXA.includes(u.papel)) return { negado: true as const };
      return { negado: false as const, valor: await montar(trx, u.clinicId, agora, de, ate) };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'nao_ve_o_caixa' });
    return reply.send(r.valor.valor);
  });
}

/**
 * A frase que abre a tela. Decisão, não indicador (DESIGN.md).
 *
 * Montada no servidor porque ela é a MESMA conta das tabelas: se a tela remontasse a
 * frase a partir dos números, duas formatações de dinheiro poderiam divergir — e a
 * primeira vez que a frase discordar da tabela, a clínica para de confiar nas duas.
 */
function mancheteDoCaixa(r: ResumoDoCaixa, deIso: string, ateIso: string): string {
  if (r.consultas === 0) {
    return deIso === ateIso
      ? 'Nenhuma consulta com preço neste dia.'
      : 'Nenhuma consulta com preço neste período.';
  }
  const diferenca = r.marcadoCents - r.esperadoCents;
  const frase = `${formatBRL(r.marcadoCents)} marcados, ${formatBRL(r.esperadoCents)} esperados.`;
  if (diferenca <= 0) return frase;
  return `${frase} ${formatBRL(diferenca)} de distância entre os dois.`;
}

async function montar(
  trx: Trx,
  clinicId: string,
  agora: Date,
  dePedido: string | undefined,
  atePedido: string | undefined,
): Promise<RespostaCaixa> {
  const clinica = await hoje.dadosDaClinica(trx, clinicId);

  /*
   * A janela é dia de CALENDÁRIO no fuso da clínica, não intervalo de UTC.
   *
   * `new Date('2026-10-05T00:00:00Z')` é 21h do dia 4 em São Paulo: a janela pegaria
   * três horas de consultas do dia anterior e perderia três do último dia. Numa tela de
   * dinheiro isso não é detalhe — é a semana fechando com o número errado, e ninguém
   * descobriria olhando, porque o total continua parecendo plausível.
   *
   * `noFuso` resolve o deslocamento e o horário de verão daquela data. `ate` é inclusivo
   * para quem lê: pedir "05 a 05" traz o dia 5 inteiro, então o limite é 00:00 do dia 6.
   */
  const hojeDaClinica = dataNoFuso(agora, clinica.fuso);
  const deIso = dePedido ?? hojeDaClinica;
  const ateIso = atePedido ?? somarDias(deIso, JANELA_PADRAO_DIAS - 1);
  const de = noFuso(deIso, '00:00', clinica.fuso);
  const ate = noFuso(somarDias(ateIso, 1), '00:00', clinica.fuso);

  const consultas = await financeiro.consultasDoPeriodo(trx, de, ate);
  const resumo = resumirCaixa(
    consultas.map((c) => ({
      profissionalId: c.professional_id,
      procedimentoId: c.procedure_id,
      status: c.status,
      preco: c.precoCents,
      precoCadastrado: c.precoCadastrado,
    })),
  );

  const nomeDoProfissional = new Map(consultas.map((c) => [c.professional_id, c.profissional]));
  const nomeDoProcedimento = new Map(consultas.map((c) => [c.procedure_id, c.procedimento]));

  return {
    clinica: { id: clinica.id, nome: clinica.nome },
    de: deIso,
    ate: ateIso,
    consultas: resumo.consultas,
    marcadoCents: resumo.marcadoCents,
    esperadoCents: resumo.esperadoCents,
    realizadoCents: resumo.realizadoCents,
    manchete: mancheteDoCaixa(resumo, deIso, ateIso),
    faltas: { quantidade: resumo.faltas.quantidade, valorCents: resumo.faltas.valor },
    semPreco: {
      consultas: resumo.semPreco.consultas,
      procedimentos: resumo.semPreco.procedimentoIds.map((id) => ({
        id,
        nome: nomeDoProcedimento.get(id) ?? 'procedimento',
      })),
    },
    porProfissional: resumo.porProfissional.map((l) => ({
      ...l,
      nome: nomeDoProfissional.get(l.id) ?? 'profissional',
    })),
    porProcedimento: resumo.porProcedimento.map((l) => ({
      ...l,
      nome: nomeDoProcedimento.get(l.id) ?? 'procedimento',
    })),
  };
}
