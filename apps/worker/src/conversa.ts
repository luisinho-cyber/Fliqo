import { planejarEnvio, quebrarEmBaloes, type RitmoClinica } from '@fliqo/core';
import {
  alertas,
  conversas,
  ia,
  numeros,
  procedimentos,
  withClinic,
  type Db,
  type Trx,
} from '@fliqo/db';
import {
  chamadasDaResposta,
  checarEntrada,
  checarSaida,
  definicoesParaApi,
  montarPromptSistema,
  PerfilClinicaSchema,
  RESPOSTA_EMERGENCIA,
  RESPOSTA_TRANSFERENCIA,
  somarUso,
  textoDaResposta,
  USO_ZERO,
  type ClienteLlm,
  type PerfilClinica,
  type TurnoLlm,
  type UsoDeTokens,
} from '@fliqo/ai';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import type { PgBoss } from 'pg-boss';
import { Executor } from './executor';
import { agendarResposta } from './resposta';

/**
 * O job 'conversa': o que a Assistente Fliqo faz quando um paciente escreve.
 *
 * A ordem importa e é sempre a mesma:
 *   1. agrupa mensagens picadas (CLAUDE.md, regra 7);
 *   2. conversa em modo humano não recebe resposta da IA (regra 5 da coexistência);
 *   3. proteções de ENTRADA em código, antes de gastar um token;
 *   4. laço de ferramentas com o executor, que injeta clinic_id e patient_id (regra 4);
 *   5. proteções de SAÍDA, com uma segunda chance antes de desistir;
 *   6. envio no ritmo humano, como jobs atrasados.
 */

export interface DependenciasDaConversa {
  db: Db;
  boss: PgBoss;
  llm: ClienteLlm;
  whatsapp: ClienteWhatsApp;
  agora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  aleatorio?: () => number;
  /** Quanto esperar por mais mensagens do mesmo paciente. */
  janelaDeAgrupamentoMs?: number;
  maxVoltas?: number;
}

export type MotivoDeNaoAtender =
  'conversa_inexistente' | 'humano' | 'nada_novo' | 'sem_perfil' | 'sem_numero';

export type ResultadoDaConversa =
  | { atendida: false; motivo: MotivoDeNaoAtender }
  | {
      atendida: true;
      /** 'ia' = respondeu; os outros saíram sem passar pelo modelo. */
      saida: 'ia' | 'emergencia' | 'transferencia';
      baloes: number;
      uso: UsoDeTokens;
    };

const JANELA_PADRAO_MS = 8_000;
const MAX_VOLTAS_PADRAO = 5;

export async function atenderConversa(
  dep: DependenciasDaConversa,
  job: { clinicId: string; conversaId: string },
): Promise<ResultadoDaConversa> {
  const agora = dep.agora ?? (() => new Date());
  const dormir = dep.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const janela = dep.janelaDeAgrupamentoMs ?? JANELA_PADRAO_MS;

  // Agrupar acontece FORA da transação: segurar uma transação aberta por 8 s
  // para esperar o paciente terminar de digitar prenderia uma conexão à toa.
  const falta = await withClinic(
    job.clinicId,
    async (trx) => {
      const c = await conversas.porId(trx, job.conversaId);
      if (!c?.last_inbound_at) return 0;
      return Math.max(0, janela - (agora().getTime() - c.last_inbound_at.getTime()));
    },
    dep.db,
  );
  if (falta > 0) await dormir(falta);

  // O laço inteiro roda dentro de UMA transação da clínica: é o que a RLS exige
  // (toda query passa por withClinic) e o que garante que uma consulta marcada e
  // a resposta que fala dela existam juntas, ou nenhuma das duas. O preço é a
  // transação ficar aberta enquanto o modelo pensa — por isso o cliente do modelo
  // tem timeout curto, e por isso a espera de 8 s fica aqui fora.
  return withClinic(job.clinicId, (trx) => processar(trx, dep, job, agora()), dep.db);
}

async function processar(
  trx: Trx,
  dep: DependenciasDaConversa,
  job: { clinicId: string; conversaId: string },
  agora: Date,
): Promise<ResultadoDaConversa> {
  const conversa = await conversas.porId(trx, job.conversaId);
  if (!conversa) return { atendida: false, motivo: 'conversa_inexistente' };
  // A clínica respondeu pelo app do celular: a assistente cala nesta conversa.
  if (conversa.mode === 'humano') return { atendida: false, motivo: 'humano' };

  const historico = await conversas.ultimasMensagens(trx, job.conversaId, 20);
  const pendentes = pendentesDoPaciente(historico);
  if (pendentes.length === 0) return { atendida: false, motivo: 'nada_novo' };

  const phoneNumberId = await numeros.ativoDaClinica(trx);
  if (phoneNumberId === undefined) return { atendida: false, motivo: 'sem_numero' };

  const perfilSalvo = await ia.perfilAtivo(trx);
  const lido = PerfilClinicaSchema.safeParse(perfilSalvo?.profile);
  if (!lido.success) {
    await alertas.criar(trx, job.clinicId, {
      tipo: 'conversa_assumida',
      gravidade: 'atencao',
      titulo: 'A assistente não tem perfil ativo válido nesta clínica',
      corpo: 'Enquanto isso, as conversas ficam com a equipe.',
      conversaId: conversa.id,
      pacienteId: conversa.patient_id,
    });
    await conversas.definirModo(trx, conversa.id, 'humano', 'perfil da assistente ausente');
    return { atendida: false, motivo: 'sem_perfil' };
  }
  const perfil = lido.data;

  const base = {
    clinicId: job.clinicId,
    conversaId: conversa.id,
    phoneNumberId,
    ...(pendentes.at(-1)?.wamid === null || pendentes.at(-1)?.wamid === undefined
      ? {}
      : { wamidRecebido: pendentes.at(-1)?.wamid as string }),
  };

  const recebido = juntar(pendentes);

  // ---- proteções de entrada: rodam antes de gastar um token ----
  const entrada = checarEntrada({ texto: recebido }, perfil.gatilhosHumanoExtras);
  const temMidia = pendentes.some((m) => m.media_kind !== null);

  if (entrada.transferir || temMidia) {
    const motivo = entrada.transferir
      ? entrada.motivo
      : // Áudio, imagem e documento ficam com a equipe nesta fase: sem
        // transcrição, responder seria adivinhar o que o paciente disse.
        'mensagem com áudio, imagem ou documento';
    const urgente = entrada.transferir && entrada.urgente;

    await conversas.definirModo(trx, conversa.id, 'humano', motivo);
    await alertas.criar(trx, job.clinicId, {
      tipo: urgente ? 'emergencia' : 'conversa_assumida',
      gravidade: urgente ? 'urgente' : 'atencao',
      titulo: urgente
        ? 'Possível emergência em uma conversa de WhatsApp'
        : 'A assistente passou uma conversa para a equipe',
      corpo: motivo,
      conversaId: conversa.id,
      pacienteId: conversa.patient_id,
    });

    const texto = urgente ? RESPOSTA_EMERGENCIA : RESPOSTA_TRANSFERENCIA;
    const baloes = await responderDireto(dep, trx, base, texto, urgente);
    return {
      atendida: true,
      saida: urgente ? 'emergencia' : 'transferencia',
      baloes,
      uso: USO_ZERO,
    };
  }

  // ---- prompt ----
  const lista = await procedimentos.listarAtivos(trx);
  const visiveis = lista.map((p) => ({
    id: p.id,
    nome: p.name,
    duracaoMin: p.duration_minutes,
    // bigint chega como string no driver; dinheiro é inteiro em centavos.
    precoCentavos: Number(p.price_cents),
    exibirPreco: perfil.politicas.precoNoWhatsapp,
  }));
  const sistema = montarPromptSistema(perfil, visiveis, agora);
  const precosPermitidos = perfil.politicas.precoNoWhatsapp
    ? visiveis.map((p) => p.precoCentavos)
    : [];

  const executor = new Executor(trx, {
    clinicId: job.clinicId,
    conversaId: conversa.id,
    pacienteId: conversa.patient_id,
    perfil,
    fuso: 'America/Sao_Paulo',
    agora,
  });

  const turnos = paraTurnos(historico);

  let uso = USO_ZERO;
  let texto = '';
  let transferiu = false;
  let modelo = '';

  for (let volta = 0; volta < (dep.maxVoltas ?? MAX_VOLTAS_PADRAO); volta++) {
    const r = await dep.llm.responder({
      sistema,
      turnos,
      ferramentas: definicoesParaApi(),
    });
    uso = somarUso(uso, r.uso);
    modelo = r.modelo;
    texto = textoDaResposta(r);

    const chamadas = chamadasDaResposta(r);
    if (r.parada !== 'ferramenta' || chamadas.length === 0) break;

    turnos.push({ papel: 'assistente', blocos: r.blocos });
    const resultados = [];
    for (const c of chamadas) {
      const s = await executor.executar(c.nome, c.entrada);
      if (s.transferir) transferiu = true;
      resultados.push({
        tipo: 'resultado' as const,
        id: c.id,
        conteudo: JSON.stringify(s.conteudo),
        ...(s.erro === true ? { erro: true } : {}),
      });
    }
    turnos.push({ papel: 'paciente', blocos: resultados });
    if (transferiu) break;
  }

  if (modelo !== '') {
    await ia.registrarConsumo(trx, job.clinicId, {
      conversaId: conversa.id,
      modelo,
      entrada: uso.entrada,
      saida: uso.saida,
      cacheLido: uso.cacheLido,
      cacheCriado: uso.cacheCriado,
    });
  }

  if (transferiu) {
    // A ferramenta já mudou o modo e criou o alerta. Falta só não deixar o
    // paciente no vácuo.
    const baloes = await responderDireto(
      dep,
      trx,
      base,
      texto === '' ? RESPOSTA_TRANSFERENCIA : texto,
      false,
    );
    return { atendida: true, saida: 'transferencia', baloes, uso };
  }

  // ---- proteções de saída, com uma segunda chance ----
  let aprovado = checarSaida(texto, precosPermitidos);
  if (!aprovado.ok) {
    const retomada = await dep.llm.responder({
      sistema,
      turnos: [
        ...turnos,
        {
          papel: 'paciente',
          blocos: [
            {
              tipo: 'texto',
              // O motivo vai junto: sem ele o modelo repete o mesmo erro.
              texto: `A resposta anterior não pôde ser enviada (${aprovado.motivo}). Reescreva sem isso, em no máximo 3 frases.`,
            },
          ],
        },
      ],
      ferramentas: definicoesParaApi(),
    });
    uso = somarUso(uso, retomada.uso);
    await ia.registrarConsumo(trx, job.clinicId, {
      conversaId: conversa.id,
      modelo: retomada.modelo,
      entrada: retomada.uso.entrada,
      saida: retomada.uso.saida,
      cacheLido: retomada.uso.cacheLido,
      cacheCriado: retomada.uso.cacheCriado,
    });
    aprovado = checarSaida(textoDaResposta(retomada), precosPermitidos);
  }

  if (!aprovado.ok || aprovado.texto === '') {
    const motivo = aprovado.ok ? 'a assistente não soube responder' : aprovado.motivo;
    await conversas.definirModo(trx, conversa.id, 'humano', motivo);
    await alertas.criar(trx, job.clinicId, {
      tipo: 'conversa_assumida',
      gravidade: 'atencao',
      titulo: 'A assistente parou de responder nesta conversa',
      corpo: motivo,
      conversaId: conversa.id,
      pacienteId: conversa.patient_id,
    });
    const baloes = await responderDireto(dep, trx, base, RESPOSTA_TRANSFERENCIA, false);
    return { atendida: true, saida: 'transferencia', baloes, uso };
  }

  const plano = planejarEnvio(
    recebido,
    aprovado.texto,
    perfil.ritmo satisfies RitmoClinica,
    dep.aleatorio ?? Math.random,
  );
  await agendarResposta(dep.boss, trx, base, plano);
  return { atendida: true, saida: 'ia', baloes: plano.baloes.length, uso };
}

/**
 * Texto que a clínica manda sem passar pelo modelo (emergência, transferência).
 * Vai pela mesma fila, com o mesmo ritmo, para não chegar em 200 ms.
 */
async function responderDireto(
  dep: DependenciasDaConversa,
  trx: Trx,
  base: Parameters<typeof agendarResposta>[2],
  texto: string,
  urgente: boolean,
): Promise<number> {
  const baloes = quebrarEmBaloes(texto).map((t) => ({
    texto: t,
    // Emergência não espera "digitando…": sai agora.
    digitandoMs: urgente ? 0 : 2_000,
  }));
  const plano = { aguardarAntesMs: urgente ? 0 : 3_000, baloes };
  await agendarResposta(dep.boss, trx, base, plano);
  return baloes.length;
}

/**
 * Histórico do banco no formato de turnos.
 *
 * Duas arrumações que a API exige e o banco não garante: a conversa tem de
 * começar pelo paciente (um lembrete enviado antes da primeira resposta dele
 * abriria o histórico com a clínica falando), e mensagens seguidas do mesmo lado
 * viram um turno só.
 */
export function paraTurnos(historico: { author: string; body: string | null }[]): TurnoLlm[] {
  const turnos: TurnoLlm[] = [];
  let comecou = false;
  for (const m of historico) {
    const papel = m.author === 'paciente' ? ('paciente' as const) : ('assistente' as const);
    if (!comecou && papel !== 'paciente') continue;
    comecou = true;

    const texto = m.body ?? '[mensagem sem texto]';
    const ultimo = turnos.at(-1);
    if (ultimo?.papel === papel) {
      ultimo.blocos.push({ tipo: 'texto', texto });
    } else {
      turnos.push({ papel, blocos: [{ tipo: 'texto', texto }] });
    }
  }
  return turnos;
}

/** As mensagens do paciente que ainda não foram respondidas. */
function pendentesDoPaciente(
  historico: {
    author: string;
    body: string | null;
    wamid: string | null;
    media_kind: string | null;
  }[],
) {
  const pendentes = [];
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (!m || m.author !== 'paciente') break;
    pendentes.unshift(m);
  }
  return pendentes;
}

/** Mensagens picadas viram uma entrada só, na ordem em que chegaram. */
function juntar(pendentes: { body: string | null }[]): string {
  return pendentes
    .map((m) => m.body ?? '')
    .filter((t) => t !== '')
    .join('\n')
    .trim();
}

export type { PerfilClinica };
