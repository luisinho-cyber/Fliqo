import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criarDb, type Db } from '../src/conexao';
import * as alertas from '../src/repos/alertas';
import * as numeros from '../src/repos/numeros';
import { withClinic } from '../src/withClinic';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from './helpers';

let db: Db;
let owner: pg.Pool;
let c: Scenario;

const NUMERO_A = '111111111111111';
const NUMERO_B = '222222222222222';

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id) values ($1, $2), ($3, $4)`,
    [c.clinicA, NUMERO_A, c.clinicB, NUMERO_B],
  );
  db = criarDb(urlDoTester());
}, 60_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

describe('app.clinic_by_phone_number_id', () => {
  it('acha a clínica do número sem haver clínica na transação', async () => {
    // É o caso do webhook: ainda não sabemos de quem é a mensagem.
    expect(await numeros.clinicaDoNumero(db, NUMERO_A)).toBe(c.clinicA);
    expect(await numeros.clinicaDoNumero(db, NUMERO_B)).toBe(c.clinicB);
  });

  it('devolve undefined para número desconhecido', async () => {
    expect(await numeros.clinicaDoNumero(db, 'nao-existe')).toBeUndefined();
  });

  it('ignora número desativado', async () => {
    await owner.query('update app.whatsapp_numbers set active = false where phone_number_id = $1', [
      NUMERO_B,
    ]);
    expect(await numeros.clinicaDoNumero(db, NUMERO_B)).toBeUndefined();
    await owner.query('update app.whatsapp_numbers set active = true where phone_number_id = $1', [
      NUMERO_B,
    ]);
  });

  it('a função é o ÚNICO caminho: a leitura direta continua presa à RLS', async () => {
    // Dentro da clínica A, a tabela só mostra o número da própria clínica —
    // mesmo a função sendo security definer, a tabela não virou pública.
    const vistos = await withClinic(
      c.clinicA,
      (trx) => trx.selectFrom('app.whatsapp_numbers').select(['phone_number_id']).execute(),
      db,
    );
    expect(vistos.map((v) => v.phone_number_id)).toEqual([NUMERO_A]);
  });

  it('sem clínica na transação, a tabela não mostra nada', async () => {
    const semClinica = await db.selectFrom('app.whatsapp_numbers').select(['id']).execute();
    expect(semClinica).toHaveLength(0);
  });
});

describe('alertas e consumo de IA respeitam a RLS', () => {
  it('alerta criado na clínica A não aparece na B', async () => {
    await withClinic(
      c.clinicA,
      (trx) =>
        alertas.criar(trx, c.clinicA, {
          tipo: 'sem_consentimento',
          gravidade: 'atencao',
          titulo: 'Paciente sem consentimento para mensagem ativa',
        }),
      db,
    );

    const naA = await withClinic(c.clinicA, (trx) => alertas.abertos(trx), db);
    const naB = await withClinic(c.clinicB, (trx) => alertas.abertos(trx), db);

    expect(naA).toHaveLength(1);
    expect(naB).toHaveLength(0);
  });

  it('resolver um alerta o tira da lista de abertos', async () => {
    const restantes = await withClinic(
      c.clinicA,
      async (trx) => {
        const [aberto] = await alertas.abertos(trx);
        await alertas.resolver(trx, aberto!.id);
        return alertas.abertos(trx);
      },
      db,
    );
    expect(restantes).toHaveLength(0);
  });

  it('consumo de IA de uma clínica não vaza para a outra', async () => {
    await withClinic(
      c.clinicA,
      (trx) =>
        trx
          .insertInto('app.ai_usage')
          .values({
            clinic_id: c.clinicA,
            model: 'claude-haiku-4-5',
            input_tokens: 800,
            output_tokens: 120,
          })
          .execute(),
      db,
    );

    const naA = await withClinic(
      c.clinicA,
      (trx) => trx.selectFrom('app.ai_usage').selectAll().execute(),
      db,
    );
    const naB = await withClinic(
      c.clinicB,
      (trx) => trx.selectFrom('app.ai_usage').selectAll().execute(),
      db,
    );

    expect(naA).toHaveLength(1);
    expect(naA[0]?.input_tokens).toBe(800);
    expect(naB).toHaveLength(0);
  });

  it('não deixa gravar alerta carimbado com outra clínica', async () => {
    // O `with check` da política barra: estar na clínica A não permite escrever na B.
    await expect(
      withClinic(
        c.clinicA,
        (trx) =>
          alertas.criar(trx, c.clinicB, {
            tipo: 'horario_vago',
            gravidade: 'info',
            titulo: 'tentativa de escrever na clínica errada',
          }),
        db,
      ),
    ).rejects.toThrow();
  });
});

describe('a RLS sem force protege a aplicação do mesmo jeito', () => {
  it('a clínica B não LÊ o número da clínica A', async () => {
    const vistos = await withClinic(
      c.clinicB,
      (trx) => trx.selectFrom('app.whatsapp_numbers').select(['phone_number_id']).execute(),
      db,
    );
    expect(vistos.map((v) => v.phone_number_id)).toEqual([NUMERO_B]);
    expect(vistos.map((v) => v.phone_number_id)).not.toContain(NUMERO_A);
  });

  it('a clínica B não GRAVA número carimbado para a clínica A', async () => {
    // O `with check` da política barra a escrita cruzada.
    await expect(
      withClinic(
        c.clinicB,
        (trx) =>
          trx
            .insertInto('app.whatsapp_numbers')
            .values({ clinic_id: c.clinicA, phone_number_id: 'roubado-pela-B' })
            .execute(),
        db,
      ),
    ).rejects.toThrow();

    const existe = await owner.query(
      'select id from app.whatsapp_numbers where phone_number_id = $1',
      ['roubado-pela-B'],
    );
    expect(existe.rows).toHaveLength(0);
  });

  it('a clínica B não ALTERA nem APAGA o número da clínica A', async () => {
    const efeito = await withClinic(
      c.clinicB,
      async (trx) => {
        const alterados = await trx
          .updateTable('app.whatsapp_numbers')
          .set({ active: false })
          .where('phone_number_id', '=', NUMERO_A)
          .executeTakeFirst();
        const apagados = await trx
          .deleteFrom('app.whatsapp_numbers')
          .where('phone_number_id', '=', NUMERO_A)
          .executeTakeFirst();
        return {
          alterados: Number(alterados.numUpdatedRows),
          apagados: Number(apagados.numDeletedRows),
        };
      },
      db,
    );

    // A RLS não deixa a linha nem ser enxergada, então nada é afetado.
    expect(efeito).toEqual({ alterados: 0, apagados: 0 });

    const daA = await owner.query<{ active: boolean }>(
      'select active from app.whatsapp_numbers where phone_number_id = $1',
      [NUMERO_A],
    );
    expect(daA.rows[0]?.active).toBe(true);
  });
});

describe('propriedades da função security definer', () => {
  it('é security definer, devolve só um uuid e tem search_path fixo', async () => {
    const { rows } = await owner.query<{
      security_definer: boolean;
      retorno: string;
      argumentos: string;
      config: string[] | null;
    }>(
      `select p.prosecdef            as security_definer,
              pg_get_function_result(p.oid)    as retorno,
              pg_get_function_arguments(p.oid) as argumentos,
              p.proconfig                      as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'clinic_by_phone_number_id'`,
    );

    expect(rows).toHaveLength(1);
    const f = rows[0];
    expect(f?.security_definer).toBe(true);
    // Devolve o uuid da clínica e nada mais — nenhuma outra coluna da tabela sai daqui.
    expect(f?.retorno).toBe('uuid');
    expect(f?.argumentos).toBe('p_phone_number_id text');
    // search_path fixo: sem isso, um schema malicioso no caminho poderia sequestrar
    // o nome `whatsapp_numbers` dentro de uma função que roda como dono.
    expect(f?.config ?? []).toContain('search_path=app, pg_temp');
  });

  it('execute está revogado de public e concedido só a fliqo_app', async () => {
    const { rows } = await owner.query<{ publico: boolean; app: boolean }>(
      `select has_function_privilege('public', p.oid, 'execute') as publico,
              has_function_privilege('fliqo_app', p.oid, 'execute') as app
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'clinic_by_phone_number_id'`,
    );

    expect(rows[0]?.publico).toBe(false);
    expect(rows[0]?.app).toBe(true);
  });
});
