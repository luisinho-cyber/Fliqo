import { ClienteAnthropic } from '@fliqo/ai';
import { criarDb, withClinic } from '@fliqo/db';
import { criarFila, FILA_BOTAO, FILA_CONVERSA, FILA_RESPOSTA } from '@fliqo/db/fila';
import { ClienteMeta } from '@fliqo/whatsapp';
import pino from 'pino';
import { rodarUmaVez } from './acoes';
import { tratarResposta } from './botao';
import { lerConfigWorker } from './config';
import { atenderConversa } from './conversa';
import { enviarBalao, type BalaoDaResposta } from './resposta';

const config = lerConfigWorker();
const log = pino({ level: config.LOG_LEVEL });
const db = criarDb(config.DATABASE_URL);
const boss = criarFila(config.DATABASE_URL);
const whatsapp = new ClienteMeta({ token: config.WHATSAPP_TOKEN });
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

let rodando = true;

/** Laço das ações agendadas. Roda a cada 30 s, sem sobrepor uma rodada na outra. */
async function laco(): Promise<void> {
  while (rodando) {
    try {
      const r = await rodarUmaVez({ db, whatsapp });
      if (r.pegas > 0 || r.devolvidas > 0) log.info(r, 'rodada de ações');
    } catch (erro) {
      // Uma rodada ruim não pode matar o worker: o próximo ciclo tenta de novo.
      log.error({ erro: erro instanceof Error ? erro.message : erro }, 'rodada falhou');
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

const encerrar = async (sinal: string): Promise<void> => {
  log.info({ sinal }, 'encerrando');
  rodando = false;
  await boss.stop();
  await db.destroy();
};

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    void encerrar(sinal).then(() => process.exit(0));
  });
}

log.info('worker no ar');
await laco();
