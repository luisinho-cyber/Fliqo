import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { criarDb, type Db } from '../src/conexao';
import { comoConexaoDoBoss } from '../src/fila-adaptador';
import * as conversas from '../src/repos/conversas';
import { withClinic } from '../src/withClinic';
import { criarFila, FILA_CONVERSA, SCHEMA_FILA } from '../scripts/fila.mjs';
import {
  ownerPool,
  prepararFilaDeTeste,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from './helpers';

/**
 * O webhook grava a mensagem e enfileira o processamento na MESMA transação.
 * Estes testes provam os dois lados dessa promessa: o que commita aparece nos
 * dois lugares, e o que falha não aparece em nenhum. Sem o segundo, a promessa
 * do PR seria só uma afirmação.
 */

let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
}, 90_000);

afterAll(async () => {
  await boss.stop();
  await db.destroy();
  await owner.end();
});

async function jobs(chave: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `select count(*) as n from ${SCHEMA_FILA}.job where name = $1 and singleton_key = $2`,
    [FILA_CONVERSA, chave],
  );
  return Number(rows[0]?.n ?? 0);
}

async function mensagens(wamid: string): Promise<number> {
  const { rows } = await owner.query('select id from app.messages where wamid = $1', [wamid]);
  return rows.length;
}

describe('gravar e enfileirar na mesma transação', () => {
  it('quando a transação commita, a mensagem e o job existem', async () => {
    const conversaId = await withClinic(
      c.clinicA,
      async (trx) => {
        const conversa = await conversas.acharOuCriarPorPaciente(trx, c.clinicA, c.patients[0]!);
        await conversas.registrar(trx, {
          conversaId: conversa.id,
          clinicId: c.clinicA,
          direcao: 'entrada',
          autor: 'paciente',
          wamid: 'wamid.COMMIT',
          corpo: 'oi',
        });
        await boss.send({
          name: FILA_CONVERSA,
          data: { conversationId: conversa.id },
          options: { singletonKey: conversa.id, db: comoConexaoDoBoss(trx) },
        });
        return conversa.id;
      },
      db,
    );

    expect(await mensagens('wamid.COMMIT')).toBe(1);
    expect(await jobs(conversaId)).toBe(1);
  });

  it('se a transação falhar depois de enfileirar, NENHUM job fica na fila', async () => {
    const conversaId = await withClinic(
      c.clinicA,
      (trx) => conversas.acharOuCriarPorPaciente(trx, c.clinicA, c.patients[1]!).then((x) => x.id),
      db,
    );

    await expect(
      withClinic(
        c.clinicA,
        async (trx) => {
          await conversas.registrar(trx, {
            conversaId,
            clinicId: c.clinicA,
            direcao: 'entrada',
            autor: 'paciente',
            wamid: 'wamid.ROLLBACK',
            corpo: 'oi',
          });
          await boss.send({
            name: FILA_CONVERSA,
            data: { conversationId: conversaId },
            options: { singletonKey: conversaId, db: comoConexaoDoBoss(trx) },
          });
          // Qualquer falha depois daqui — banco fora do ar, bug, timeout.
          throw new Error('falha depois de enfileirar');
        },
        db,
      ),
    ).rejects.toThrow('falha depois de enfileirar');

    // O job não ficou órfão...
    expect(await jobs(conversaId)).toBe(0);
    // ...e a mensagem também não ficou gravada sem processamento.
    expect(await mensagens('wamid.ROLLBACK')).toBe(0);
  });

  it('se o enfileiramento falhar, a mensagem também não fica gravada', async () => {
    const conversaId = await withClinic(
      c.clinicA,
      (trx) => conversas.acharOuCriarPorPaciente(trx, c.clinicA, c.patients[2]!).then((x) => x.id),
      db,
    );

    await expect(
      withClinic(
        c.clinicA,
        async (trx) => {
          await conversas.registrar(trx, {
            conversaId,
            clinicId: c.clinicA,
            direcao: 'entrada',
            autor: 'paciente',
            wamid: 'wamid.FILA_RUIM',
            corpo: 'oi',
          });
          // Fila que não existe: o pg-boss recusa.
          await boss.send({
            name: 'fila-que-nao-existe',
            data: {},
            options: { db: comoConexaoDoBoss(trx) },
          });
        },
        db,
      ),
    ).rejects.toThrow();

    expect(await mensagens('wamid.FILA_RUIM')).toBe(0);
  });
});
