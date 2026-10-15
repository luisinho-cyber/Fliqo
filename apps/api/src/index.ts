import { AMBIENTE_DA_API, travarAmbiente } from '@fliqo/core';
import { criarDb } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import { construirApp } from './app';

/*
 * As travas do ambiente, antes de qualquer outra coisa.
 *
 * Primeira instrução do processo de propósito: subir sem o segredo do webhook
 * seria aceitar qualquer mensagem como se fosse da Meta, e abrir o pool antes de
 * conferir a conexão seria fazer justamente o que a trava existe para impedir.
 * As quatro recusas e o porquê de cada uma estão em packages/core/src/ambiente.ts.
 */
const config = travarAmbiente('a api', AMBIENTE_DA_API);

/**
 * Tetos de conexão, explícitos.
 *
 * São dois pools — o da Kysely e o do pg-boss —, e o pooler do Supabase é
 * compartilhado com o worker e com as migrações. O pg-boss da api quase não usa
 * o dele: a api enfileira DENTRO da transação da requisição
 * (`comoConexaoDoBoss`), então o pool próprio dele serve só para o `start`. A
 * conta completa está em docs/DEPLOY.md.
 */
const POOL_CONSULTAS = 8;
const POOL_DA_FILA = 2;

const db = criarDb(config.DATABASE_URL, POOL_CONSULTAS);
const boss = criarFila(config.DATABASE_URL, POOL_DA_FILA);

await boss.start();

const app = construirApp({ config, db, boss });

const encerrar = async (sinal: string): Promise<void> => {
  app.log.info({ sinal }, 'encerrando');
  await app.close();
  await boss.stop();
  await db.destroy();
};

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    void encerrar(sinal).then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
