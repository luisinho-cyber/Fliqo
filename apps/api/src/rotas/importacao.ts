import {
  CAMPOS_OBRIGATORIOS,
  descobrirSeparador,
  lerLinha,
  MAXIMO_DE_LINHAS,
  separarCampos,
  type MapaDeColunas,
  type MotivoDeRecusa,
} from '@fliqo/core';
import { atrasos, importacao, type Trx } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { comUsuario, UUID, type ContextoPainel } from './contexto';

/**
 * Importar a agenda do sistema que a clínica já usa.
 *
 * O painel manda o TEXTO do arquivo e o mapeamento que a clínica escolheu na tela.
 * Quem separa os campos, valida e grava é o servidor — o navegador só leu o arquivo
 * para poder mostrar os cabeçalhos e deixar a pessoa dizer qual coluna é qual.
 *
 * Tudo numa transação: ou a importação existe com o relatório dela, ou não existe.
 * Relatório gravado sem as consultas (ou o contrário) seria a clínica acreditando
 * num número que não corresponde à agenda.
 *
 * Só o dono: mexer na agenda inteira em lote não é operação de recepção.
 */

const PedidoDeImportacao = z.object({
  arquivo: z.string().min(1).max(200),
  texto: z.string().min(1),
  mapa: z.object({
    paciente: z.number().int().min(0),
    telefone: z.number().int().min(0),
    profissional: z.number().int().min(0),
    inicio: z.number().int().min(0),
    procedimento: z.number().int().min(0),
  }),
  /** A primeira linha é cabeçalho? Quase sempre sim, mas há export que vem sem. */
  temCabecalho: z.boolean().default(true),
});

export interface RecusaNaTela {
  linha: number;
  /**
   * `string` e não `MotivoDeRecusa`: a coluna `reason` é texto no banco, e o
   * relatório de uma importação ANTIGA pode trazer um motivo que a lista de hoje já
   * não tem. A tela cai no texto cru nesse caso, em vez de sumir com a linha.
   */
  motivo: string;
  rotulo: string;
}

export interface RelatorioDaImportacao {
  id: string;
  arquivo: string;
  em: string;
  total: number;
  entraram: number;
  repetidas: number;
  recusadas: number;
  /** Só as recusadas, com o motivo. Linha recusada nunca some em silêncio. */
  recusas: RecusaNaTela[];
}

/**
 * Recusa do ARQUIVO inteiro, que é falha esperada e não erro: planilha vazia e
 * planilha grande demais são coisas que acontecem, e a clínica precisa ler o motivo
 * em português. Vão com 200 e `{ ok: false }`, no estilo do projeto — 400 fica para
 * pedido malformado, que é bug do nosso próprio painel, não da clínica.
 */
export const MOTIVOS_DO_ARQUIVO = ['planilha_sem_linhas', 'planilha_grande_demais'] as const;
export type MotivoDoArquivo = (typeof MOTIVOS_DO_ARQUIVO)[number];

export type SaidaDaImportacao =
  | { ok: true; relatorio: RelatorioDaImportacao }
  | { ok: false; motivo: MotivoDoArquivo; maximo: number };

export function registrarImportacao(app: FastifyInstance, ctx: ContextoPainel): void {
  app.post('/api/importacoes', async (req, reply) => {
    const pedido = PedidoDeImportacao.safeParse(req.body);
    if (!pedido.success) return reply.code(400).send({ erro: 'pedido_invalido' });

    const { arquivo, texto, mapa, temCabecalho } = pedido.data;
    const separador = descobrirSeparador(texto);
    const linhas = separarCampos(texto, separador);
    const corpo = temCabecalho ? linhas.slice(1) : linhas;

    if (corpo.length === 0) {
      return reply.send({
        ok: false,
        motivo: 'planilha_sem_linhas',
        maximo: MAXIMO_DE_LINHAS,
      } satisfies SaidaDaImportacao);
    }
    if (corpo.length > MAXIMO_DE_LINHAS) {
      return reply.send({
        ok: false,
        motivo: 'planilha_grande_demais',
        maximo: MAXIMO_DE_LINHAS,
      } satisfies SaidaDaImportacao);
    }

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (u.papel !== 'dono') return { negado: true as const };
      return {
        negado: false as const,
        valor: await importar(trx, u.clinicId, u.userId, {
          arquivo,
          corpo,
          mapa,
          deslocamento: temCabecalho ? 2 : 1,
        }),
      };
    });

    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'apenas_dono_importa_agenda' });
    return reply.send({ ok: true, relatorio: r.valor.valor } satisfies SaidaDaImportacao);
  });

  app.get('/api/importacoes', async (req, reply) => {
    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (u.papel !== 'dono') return { negado: true as const };
      const feitas = await importacao.listar(trx);
      const clinica = await atrasos.fusoDaClinica(trx, u.clinicId);
      return {
        negado: false as const,
        valor: {
          // O fuso é lido junto porque a tela mostra a data da importação na hora
          // da clínica, e não na do navegador de quem abriu.
          fuso: clinica,
          importacoes: feitas.map((i) => ({
            id: i.id,
            arquivo: i.file_name,
            em: i.created_at.toISOString(),
            total: i.rows_total,
            entraram: i.rows_imported,
            repetidas: i.rows_repeated,
            recusadas: i.rows_rejected,
          })),
        },
      };
    });
    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'apenas_dono_ve_importacoes' });
    return reply.send(r.valor.valor);
  });

  app.get('/api/importacoes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ erro: 'pedido_invalido' });

    const r = await comUsuario(ctx, req, reply, async (trx, u) => {
      if (u.papel !== 'dono') return { negado: true as const, achado: undefined };
      const feita = await importacao.porId(trx, id);
      if (feita === undefined) return { negado: false as const, achado: undefined };
      const recusas = await importacao.recusasDaImportacao(trx, id);
      return {
        negado: false as const,
        achado: {
          id: feita.id,
          arquivo: feita.file_name,
          em: feita.created_at.toISOString(),
          total: feita.rows_total,
          entraram: feita.rows_imported,
          repetidas: feita.rows_repeated,
          recusadas: feita.rows_rejected,
          recusas: recusas.map((l) => ({
            linha: l.line_number,
            motivo: l.reason,
            rotulo: l.label,
          })),
        } satisfies RelatorioDaImportacao,
      };
    });
    if (r.respondido) return reply;
    if (r.valor.negado) return reply.code(403).send({ erro: 'apenas_dono_ve_importacoes' });
    if (r.valor.achado === undefined)
      return reply.code(404).send({ erro: 'importacao_nao_achada' });
    return reply.send(r.valor.achado);
  });
}

/**
 * O mapeamento precisa cobrir os cinco campos. O Zod já garante que eles existem;
 * esta lista garante que CAMPO NOVO quebre aqui em vez de entrar sem mapeamento.
 */
function mapaCompleto(mapa: MapaDeColunas): boolean {
  return CAMPOS_OBRIGATORIOS.every((c) => Number.isInteger(mapa[c]));
}

async function importar(
  trx: Trx,
  clinicId: string,
  autorUserId: string,
  o: {
    arquivo: string;
    corpo: string[][];
    mapa: MapaDeColunas;
    /** Em que número a primeira linha do corpo está no arquivo, para o relatório. */
    deslocamento: number;
  },
): Promise<RelatorioDaImportacao> {
  if (!mapaCompleto(o.mapa)) throw new Error('mapeamento incompleto passou pela validação');

  const fuso = await atrasos.fusoDaClinica(trx, clinicId);
  const recusas: { linha: number; motivo: MotivoDeRecusa; rotulo: string }[] = [];
  let entraram = 0;
  let repetidas = 0;

  for (const [i, campos] of o.corpo.entries()) {
    // O número que a pessoa vê no editor de planilha, não o índice do array: ela
    // vai abrir o arquivo nessa linha para consertar.
    const numeroNoArquivo = i + o.deslocamento;

    const leitura = lerLinha(campos, o.mapa);
    if (!leitura.ok) {
      recusas.push({ linha: numeroNoArquivo, motivo: leitura.motivo, rotulo: leitura.rotulo });
      continue;
    }

    const gravada = await importacao.gravarLinha(trx, clinicId, leitura.linha, fuso);
    if (gravada.entrou) entraram++;
    else if (gravada.repetida) repetidas++;
    else {
      recusas.push({
        linha: numeroNoArquivo,
        motivo: gravada.motivo ?? 'horario_ocupado',
        rotulo: leitura.linha.paciente,
      });
    }
  }

  const contas = {
    total: o.corpo.length,
    entraram,
    repetidas,
    recusadas: recusas.length,
  };
  const registro = await importacao.registrarImportacao(trx, clinicId, {
    autorUserId,
    arquivo: o.arquivo,
    contas,
  });
  await importacao.registrarRecusas(trx, clinicId, registro.id, recusas);

  return {
    id: registro.id,
    arquivo: registro.file_name,
    em: registro.created_at.toISOString(),
    ...contas,
    recusas,
  };
}
