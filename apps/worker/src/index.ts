import { ClienteAnthropic } from '@fliqo/ai';
import { criarDb, recusarAdminUrl, withClinic } from '@fliqo/db';
import {
  criarFila,
  FILA_ATRASOS,
  FILA_BOTAO,
  FILA_CONVERSA,
  FILA_OFERTA,
  FILA_RESPOSTA,
} from '@fliqo/db/fila';
import { ClienteMeta, lerChave } from '@fliqo/whatsapp';
import pino from 'pino';
import { varrerAtrasos, varrerClinica } from './atrasos';
import { abrirRodada } from './ofertas';
import { tratarResposta } from './botao';
import { lerConfigWorker } from './config';
import { atenderConversa } from './conversa';
import { criarCofre } from './cofre';
import { criarParada, rodarLaco, rodarLacoVigiado } from './parada';
import { vigiarOperador } from './vigia-de-operador';
import { enviarBalao, type BalaoDaResposta } from './resposta';
import { criarSinaisDeSaude, registrarLaco, servidorDeSaude } from './saude';
import { iniciarLacoDeAcoes } from './laco-de-acoes';

/**
 * Tetos de conexão, explícitos.
 *
 * São dois pools por serviço — o da Kysely e o do pg-boss — e o pooler do
 * Supabase é compartilhado com a api e com as migrações. Sem teto, cada serviço
 * consome o dobro do que parece e o pooler esgota no primeiro pico. A conta de
 * onde saem estes números está em docs/DEPLOY.md.
 */
const POOL_CONSULTAS = 6;
const POOL_DA_FILA = 5;

const config = lerConfigWorker();
// Antes de qualquer conexão: o worker não sobe conhecendo a URL de dono do schema.
recusarAdminUrl('o worker');
const log = pino({ level: config.LOG_LEVEL });
const db = criarDb(config.DATABASE_URL, POOL_CONSULTAS);
const boss = criarFila(config.DATABASE_URL, POOL_DA_FILA);
/**
 * O cliente não guarda token: ele pergunta ao cofre, a cada envio, qual é o
 * token daquele número. Cada clínica manda com a credencial dela.
 */
const cofre = criarCofre({ db, chave: lerChave(config.WHATSAPP_TOKEN_KEY) });
const whatsapp = new ClienteMeta({ cofre });
const llm = new ClienteAnthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  modelo: config.ANTHROPIC_MODEL,
});

await boss.start();

// Resposta de botão: chega pelo webhook, é executada aqui.
await boss.work<{
  clinicId: string;
  pacienteId: string;
  payloadBotao: string;
}>(FILA_BOTAO, async ([job]) => {
  if (!job) return;
  const { clinicId, pacienteId, payloadBotao } = job.data;
  const r = await withClinic(
    clinicId,
    (trx) => tratarResposta(trx, whatsapp, { clinicId, pacienteId, payloadBotao }),
    db,
  );
  log.info({ clinicId, resultado: r }, 'resposta de botão tratada');
});

// A Assistente Fliqo. A fila 'conversa' é `stately` com singletonKey no
// conversation_id: duas mensagens seguidas do mesmo paciente não viram duas
// respostas paralelas (CLAUDE.md, regra 7).
await boss.work<{ clinicId: string; conversationId: string }>(FILA_CONVERSA, async ([job]) => {
  if (!job) return;
  const { clinicId, conversationId } = job.data;
  const r = await atenderConversa(
    { db, boss, llm, whatsapp },
    { clinicId, conversaId: conversationId },
  );
  log.info({ clinicId, conversaId: conversationId, ...r }, 'conversa processada');
});

// Cada balão da resposta, no horário que planejarEnvio decidiu.
await boss.work<BalaoDaResposta>(FILA_RESPOSTA, async ([job]) => {
  if (!job) return;
  const balao = job.data;
  const r = await withClinic(balao.clinicId, (trx) => enviarBalao(trx, whatsapp, balao), db);
  if (!r.ok) log.info({ clinicId: balao.clinicId, motivo: r.motivo }, 'balão não saiu');
});

// Toque na tela Hoje: a varredura daquela clínica roda na hora, sem esperar
// o laço de 2 min. É a diferença entre avisar o paciente antes de ele sair de
// casa e avisar quando ele já está no carro.
await boss.work<{ clinicId: string }>(FILA_ATRASOS, async ([job]) => {
  if (!job) return;
  const r = await varrerClinica({ db, whatsapp }, job.data.clinicId);
  if (r.avisosAoPaciente > 0 || r.alertasDeRecepcao > 0 || r.alertasDeEspera > 0) {
    log.info({ clinicId: job.data.clinicId, ...r }, 'atrasos após toque');
  }
});

// Horário vago oferecido pelo painel. Quem pediu foi a recepção; quem fala com
// o WhatsApp é este worker. A fila é `stately` com singletonKey na vaga: dois
// cliques no mesmo horário não viram duas rodadas de oferta.
await boss.work<{ clinicId: string; profissionalId: string; inicio: string; fim: string }>(
  FILA_OFERTA,
  async ([job]) => {
    if (!job) return;
    const { clinicId, profissionalId, inicio, fim } = job.data;
    const r = await withClinic(
      clinicId,
      (trx) =>
        abrirRodada(
          trx,
          whatsapp,
          clinicId,
          { profissionalId, inicio: new Date(inicio), fim: new Date(fim) },
          new Date(),
        ),
      db,
    );
    log.info({ clinicId, ofertados: r.ofertados, motivo: r.motivo }, 'vaga oferecida pelo painel');
  },
);

const parada = criarParada();
const sinais = criarSinaisDeSaude();
const lacoDeAcoes = iniciarLacoDeAcoes({ parada, db, whatsapp, log, sinais });
const batimentoDeAtrasos = registrarLaco(sinais, 'atrasos');

/**
 * Laço dos atrasos. A cada 2 min porque um atraso que cresce entre uma volta e
 * outra ainda dá tempo de ser avisado antes de o paciente sair de casa.
 */
const lacoDeAtrasos = rodarLacoVigiado({
  parada,
  batimento: batimentoDeAtrasos,
  intervaloMs: 120_000,
  aoFalhar: (erro) => {
    log.error({ erro: erro instanceof Error ? erro.message : erro }, 'varredura de atrasos falhou');
  },
  tarefa: async () => {
    const r = await varrerAtrasos({ db, whatsapp });
    if (r.avisosAoPaciente > 0 || r.alertasDeRecepcao > 0 || r.alertasDeEspera > 0) {
      log.info(r, 'varredura de atrasos');
    }
  },
});

/**
 * O vigia de operador. A cada 15 min, e ele mesmo decide se está em horário de avisar.
 *
 * Quinze minutos e não trinta porque a carência de "WhatsApp fora" é de vinte: com meia hora
 * de laço, uma queda de vinte e um minutos poderia esperar outros vinte e nove para virar
 * e-mail, e aí a carência passaria a ser de cinquenta sem ninguém ter escolhido isso.
 *
 * Fora do batimento de vida de propósito: o /estado do worker fala dos laços que entregam
 * mensagem de paciente. Um vigia travado é ruim, mas não é a mesma urgência de a régua parar,
 * e misturá-los faria o /estado dizer `travado` com a régua funcionando.
 */
const lacoDoVigia = rodarLaco({
  parada,
  intervaloMs: 900_000,
  aoFalhar: (erro) => {
    log.error({ erro: erro instanceof Error ? erro.message : erro }, 'vigia de operador falhou');
  },
  tarefa: async () => {
    const r = await vigiarOperador({
      db,
      email: {
        chave: config.EMAIL_API_KEY,
        remetente: config.EMAIL_REMETENTE,
        destinatario: config.OPERADOR_EMAIL,
        url: config.EMAIL_API_URL,
      },
      fusoDoOperador: config.OPERADOR_FUSO,
    });
    // Nada de chave, nada de e-mail: só contagens e id de clínica.
    if (r.avisadas > 0 || r.falhas.length > 0) log.info(r, 'vigia de operador');
  },
});

const lacos = Promise.all([lacoDeAcoes, lacoDeAtrasos, lacoDoVigia]);

const saude = servidorDeSaude({
  porta: config.PORT,
  sinais,
  tokenDoEstado: config.ESTADO_TOKEN,
});

/**
 * SIGTERM chega a cada deploy do Railway.
 *
 * A ordem é o que evita ação travada: primeiro para de reclamar trabalho novo,
 * depois espera a volta em curso terminar, e só então fecha fila e banco. Sair
 * antes deixaria a linha em `executando` esperando o requeue — que continua sendo
 * a rede de baixo, mas deixa de ser o caminho normal de todo deploy.
 *
 * O prazo existe porque o Railway não espera para sempre: passado ele, é melhor
 * sair e deixar o requeue trabalhar do que levar SIGKILL no meio.
 */
const PRAZO_DE_SAIDA_MS = 25_000;

const encerrar = async (sinal: string): Promise<void> => {
  log.info({ sinal }, 'encerrando: terminando o que está na mão');
  parada.pedir();
  saude.close();

  const noPrazo = await Promise.race([
    lacos.then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, PRAZO_DE_SAIDA_MS);
    }),
  ]);
  if (!noPrazo) {
    log.warn({ prazoMs: PRAZO_DE_SAIDA_MS }, 'prazo esgotado, saindo com volta aberta');
  }

  await boss.stop();
  await db.destroy();
  log.info({ sinal, noPrazo }, 'encerrado');
};

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    void encerrar(sinal).then(() => process.exit(0));
  });
}

log.info({ porta: config.PORT }, 'worker no ar');
await lacos;
