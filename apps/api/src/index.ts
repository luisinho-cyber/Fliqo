import { criarDb } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import { construirApp } from './app';
import { lerConfig } from './config';

// A configuração é validada aqui: subir sem o segredo do webhook seria aceitar
// qualquer mensagem como se fosse da Meta.
const config = lerConfig();
const db = criarDb(config.DATABASE_URL);
const boss = criarFila(config.DATABASE_URL);

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
