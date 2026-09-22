#!/usr/bin/env node
/**
 * Prepara a fila (pg-boss) no mesmo Postgres do resto do sistema.
 *
 * Roda com a conexão de dono, depois das migrações: a 0003 cria o schema `pgboss`
 * vazio e deixa os privilégios padrão prontos, e é aqui que o pg-boss cria as
 * tabelas dele dentro — herdando esses privilégios. A aplicação, que conecta como
 * fliqo_app, enfileira sem nunca ter direito de criar schema.
 *
 * A fila 'conversa' usa a política `stately`: no máximo um job por estado para a
 * mesma singletonKey (o conversation_id). Isso é a regra 7 do CLAUDE.md em forma
 * de configuração — duas mensagens seguidas do mesmo paciente não viram dois
 * processamentos paralelos. Sem política, `singletonKey` não deduplica nada:
 * a fila `standard` aceita quantos jobs iguais aparecerem.
 */
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';

export const SCHEMA_FILA = 'pgboss';
export const FILA_CONVERSA = 'conversa';
// Resposta de botão tem payload fixo e efeito decidido por packages/core. Fila
// própria para nunca cair no agente de IA, que interpretaria texto onde não há.
export const FILA_BOTAO = 'botao';

/** Instância só para enfileirar: não supervisiona nem roda agendamentos. */
export function criarFila(connectionString) {
  return new PgBoss({
    connectionString,
    schema: SCHEMA_FILA,
    supervise: false,
    schedule: false,
  });
}

export async function prepararFila(connectionString) {
  const boss = criarFila(connectionString);
  await boss.start();
  try {
    await boss.createQueue(FILA_CONVERSA, { policy: 'stately' });
    await boss.createQueue(FILA_BOTAO, { policy: 'standard' });
  } finally {
    await boss.stop();
  }
  return [FILA_CONVERSA, FILA_BOTAO];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL não definida — a fila é criada com a conexão de dono.');
    process.exit(1);
  }
  try {
    const filas = await prepararFila(url);
    console.log(`fila pronta: ${filas.join(', ')}`);
  } catch (erro) {
    console.error(`falhou: ${erro.message}`);
    process.exit(1);
  }
}
