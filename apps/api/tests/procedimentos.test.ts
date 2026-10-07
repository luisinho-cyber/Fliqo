import { criarDb, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import {
  prepararFilaDeTeste,
  ownerPool,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';
import type { RespostaCaixa } from '../src/rotas/caixa';
import type { RespostaProcedimentos } from '../src/rotas/procedimentos';

/**
 * O cadastro de procedimentos.
 *
 * O teste que mais importa não é o CRUD: é o que prova que mexer no cadastro HOJE não
 * reescreve o passado. Preço é snapshot na consulta desde a 0001, e esta fase não criou
 * um segundo caminho — então o teste do mês fechado é o que garante que continua assim.
 */

/**
 * Alfanumérico e com 32+ caracteres de propósito: é o formato que a guarda do
 * `SUPABASE_JWT_SECRET` exige, e usar aqui um valor com hífen faria este teste quebrar no
 * dia em que aquela guarda mesclar. Valor visivelmente falso, como manda a regra.
 */
const JWT_SECRET = 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890';
const segredo = new TextEncoder().encode(JWT_SECRET);
const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';
const RECEPCAO_DA_A = '44444444-4444-4444-8444-444444444444';
const FINANCEIRO_DA_A = '55555555-5555-4555-8555-555555555555';

const config: Config = {
  DATABASE_URL: 'nao-usado',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app',
  META_APP_SECRET: 'segredo',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(segredo);
}

async function chamar(
  metodo: 'GET' | 'POST',
  url: string,
  o: { userId?: string; clinica?: string; corpo?: object } = {},
): Promise<LightMyRequestResponse> {
  const opcoes: InjectOptions = {
    method: metodo,
    url,
    headers: {
      authorization: `Bearer ${await token(o.userId ?? DONA_DA_A)}`,
      'x-clinica': o.clinica ?? c.clinicA,
    },
  };
  if (o.corpo !== undefined) opcoes.payload = o.corpo;
  return app.inject(opcoes);
}

async function listar(
  o: { userId?: string; clinica?: string } = {},
): Promise<RespostaProcedimentos> {
  const r = await chamar('GET', '/api/procedimentos', o);
  expect(r.statusCode).toBe(200);
  return r.json<RespostaProcedimentos>();
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role)
     values ($1,$2,'dono'), ($3,$4,'dono'), ($1,$5,'recepcao'), ($1,$6,'financeiro')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B, RECEPCAO_DA_A, FINANCEIRO_DA_A],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.appointments');
  // Os três do cenário voltam ao estado original; o resto sai.
  await owner.query(`delete from app.procedures where id <> all($1::uuid[])`, [
    [c.procEletivo, c.procUrgente, c.procLongo],
  ]);
  await owner.query(
    `update app.procedures set active = true, source = 'cadastro', price_cents = 25000,
            duration_updated_at = null, duration_updated_by = null
      where id = $1`,
    [c.procEletivo],
  );
});

describe('cadastrar', () => {
  it('a dona cadastra e ele aparece na lista', async () => {
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento', duracaoMinutos: 45, precoCents: 90_000 },
    });
    expect(r.statusCode).toBe(201);

    const { procedimentos } = await listar();
    const novo = procedimentos.find((p) => p.nome === 'Clareamento');
    expect(novo).toMatchObject({
      duracaoMinutos: 45,
      precoCents: 90_000,
      ativo: true,
      daImportacao: false,
      semPreco: false,
      consultas: 0,
    });
  });

  /** O teste que você nomeou: nome duplicado na mesma clínica é recusado COM MOTIVO. */
  it('nome repetido na mesma clínica é recusado com motivo', async () => {
    await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento', duracaoMinutos: 45, precoCents: 90_000 },
    });
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento', duracaoMinutos: 30, precoCents: 50_000 },
    });
    // 409 e não 400: o pedido está bem formado, o nome é que já existe.
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ erro: 'nome_repetido' });

    // E o primeiro não foi alterado pela tentativa.
    const { procedimentos } = await listar();
    expect(procedimentos.filter((p) => p.nome === 'Clareamento')).toHaveLength(1);
    expect(procedimentos.find((p) => p.nome === 'Clareamento')?.precoCents).toBe(90_000);
  });

  it('maiúscula e minúscula são o mesmo nome', async () => {
    // "Limpeza" e "limpeza" conviverem é a mesma confusão com dois nomes, e a importação
    // acha procedimento POR NOME: com dois iguais, ela pega um arbitrário.
    await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento', duracaoMinutos: 45, precoCents: 90_000 },
    });
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'CLAREAMENTO', duracaoMinutos: 45, precoCents: 90_000 },
    });
    expect(r.statusCode).toBe(409);
  });

  it('nome repetido com procedimento INATIVO também é recusado', async () => {
    // Liberar o nome ao inativar deixaria dois registros iguais no banco. A tela manda
    // reativar em vez de criar uma sombra.
    const { procedimentos } = await listar();
    const limpeza = procedimentos.find((p) => p.id === c.procEletivo);
    await chamar('POST', `/api/procedimentos/${c.procEletivo}/ativo`, { corpo: { ativo: false } });

    const r = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: limpeza?.nome ?? '', duracaoMinutos: 30, precoCents: 10_000 },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ erro: 'nome_repetido' });
  });

  it('o mesmo nome em OUTRA clínica passa', async () => {
    await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento', duracaoMinutos: 45, precoCents: 90_000 },
    });
    const r = await chamar('POST', '/api/procedimentos', {
      userId: DONA_DA_B,
      clinica: c.clinicB,
      corpo: { nome: 'Clareamento', duracaoMinutos: 45, precoCents: 90_000 },
    });
    expect(r.statusCode, 'a unicidade vazou entre clínicas').toBe(201);
  });

  it('duração fora do que a agenda aceita é recusada antes do banco', async () => {
    for (const duracaoMinutos of [0, 4, 601]) {
      const r = await chamar('POST', '/api/procedimentos', {
        corpo: { nome: `Teste ${String(duracaoMinutos)}`, duracaoMinutos, precoCents: 1000 },
      });
      expect(r.statusCode, `duração ${String(duracaoMinutos)} passou`).toBe(400);
    }
  });

  /**
   * O teto existe contra o dedo escorregando no zero: R$ 3.500 digitado como
   * 350000000 centavos entraria calado e apareceria como três milhões no Caixa.
   */
  it('preço absurdo é recusado', async () => {
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Dedo escorregou', duracaoMinutos: 30, precoCents: 350_000_000 },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('editar', () => {
  it('muda preço e duração, e carimba quem mudou a duração', async () => {
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      corpo: { precoCents: 30_000, duracaoMinutos: 45 },
    });
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query<{
      price_cents: string;
      duration_minutes: number;
      duration_updated_by: string | null;
    }>(
      'select price_cents, duration_minutes, duration_updated_by from app.procedures where id = $1',
      [c.procEletivo],
    );
    expect(rows[0]).toMatchObject({
      price_cents: '30000',
      duration_minutes: 45,
      duration_updated_by: DONA_DA_A,
    });
  });

  it('mudar só o preço não carimba autor de duração', async () => {
    // O carimbo responde "quem encurtou a limpeza?". Carimbar em mudança de preço faria
    // a resposta mentir.
    await chamar('POST', `/api/procedimentos/${c.procEletivo}`, { corpo: { precoCents: 30_000 } });
    const { rows } = await owner.query<{ duration_updated_at: Date | null }>(
      'select duration_updated_at from app.procedures where id = $1',
      [c.procEletivo],
    );
    expect(rows[0]?.duration_updated_at).toBeNull();
  });

  it('renomear para um nome que já existe é recusado', async () => {
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      corpo: { nome: 'Dor aguda' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ erro: 'nome_repetido' });
  });

  it('procedimento de outra clínica dá 404, não edição', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Da outra clínica', 30, 10000) returning id`,
      [c.clinicB],
    );
    const daB = rows[0]?.id ?? '';
    const r = await chamar('POST', `/api/procedimentos/${daB}`, { corpo: { precoCents: 99_999 } });
    // A RLS não acha a linha: para a clínica A ele não existe.
    expect(r.statusCode).toBe(404);

    const { rows: depois } = await owner.query<{ price_cents: string }>(
      'select price_cents from app.procedures where id = $1',
      [daB],
    );
    expect(depois[0]?.price_cents).toBe('10000');
  });

  it('pedido vazio é recusado', async () => {
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, { corpo: {} });
    expect(r.statusCode).toBe(400);
  });
});

describe('inativar nunca apaga', () => {
  /** O teste que você nomeou: inativar não some do histórico. */
  it('inativar tira da agenda e deixa a consulta antiga inteira', async () => {
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status)
       values ($1,$2,$3,$4, now() - interval '30 days', now() - interval '30 days' + interval '1 hour',
               25000, 'realizado')
       returning id`,
      [c.clinicA, c.profA, paciente, c.procEletivo],
    );
    const consulta = rows[0]?.id;

    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/ativo`, {
      corpo: { ativo: false },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, ativo: false });

    // A consulta continua lá, apontando para o procedimento, com o preço dela.
    const { rows: depois } = await owner.query<{ procedure_id: string; price_cents: string }>(
      'select procedure_id, price_cents from app.appointments where id = $1',
      [consulta],
    );
    expect(depois[0], 'inativar apagou ou desligou a consulta do histórico').toMatchObject({
      procedure_id: c.procEletivo,
      price_cents: '25000',
    });

    // E o procedimento continua na lista de cadastro, marcado como inativo.
    const { procedimentos } = await listar();
    const limpeza = procedimentos.find((p) => p.id === c.procEletivo);
    expect(limpeza).toMatchObject({ ativo: false, consultas: 1 });
  });

  it('reativar devolve para a agenda', async () => {
    await chamar('POST', `/api/procedimentos/${c.procEletivo}/ativo`, { corpo: { ativo: false } });
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/ativo`, {
      corpo: { ativo: true },
    });
    expect(r.json()).toEqual({ ok: true, ativo: true });
  });

  it('não existe rota de apagar', async () => {
    // A ausência é a regra, não esquecimento: apagar reescreveria o passado.
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/procedimentos/${c.procEletivo}`,
      headers: { authorization: `Bearer ${await token(DONA_DA_A)}`, 'x-clinica': c.clinicA },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('preço novo não reescreve o passado', () => {
  /**
   * O teste que você nomeou, e o que mais importa nesta fase.
   *
   * O preço é snapshot na consulta desde a 0001 (`agenda.criar` copia do procedimento no
   * momento da marcação), e esta fase NÃO criou um segundo caminho. Este teste é o que
   * garante que continua assim: se alguém "melhorar" o Caixa para ler o preço atual do
   * procedimento, o caixa de um mês fechado muda de valor e nada mais quebra.
   */
  it('mudar o preço hoje não muda o Caixa de um mês fechado', async () => {
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');

    // Uma consulta realizada no mês passado, pelo preço da época.
    await owner.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status, confirmed_at)
       values ($1,$2,$3,$4,
               date_trunc('month', now()) - interval '10 days',
               date_trunc('month', now()) - interval '10 days' + interval '1 hour',
               25000, 'realizado', now() - interval '40 days')`,
      [c.clinicA, c.profA, paciente, c.procEletivo],
    );

    const dia = new Date(Date.now() - 86_400_000 * 10);
    const mesFechado = `${String(dia.getUTCFullYear())}-${String(dia.getUTCMonth() + 1).padStart(2, '0')}`;
    const de = `${mesFechado}-01`;
    const ate = `${mesFechado}-28`;

    const antes = await chamar('GET', `/api/caixa?de=${de}&ate=${ate}`);
    const marcadoAntes = antes.json<RespostaCaixa>().marcadoCents;
    expect(marcadoAntes, 'o cenário não produziu consulta no mês fechado').toBeGreaterThan(0);

    // A clínica reajusta o preço hoje: dobra.
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      corpo: { precoCents: 50_000 },
    });
    expect(r.statusCode).toBe(200);

    const depois = await chamar('GET', `/api/caixa?de=${de}&ate=${ate}`);
    expect(
      depois.json<RespostaCaixa>().marcadoCents,
      'o reajuste de hoje mudou o caixa de um mês fechado',
    ).toBe(marcadoAntes);
  });

  /**
   * A outra metade: sem isto, "não reescreve o passado" poderia virar "não vale nunca".
   *
   * Vai pela ROTA de marcar, e não por um INSERT escrito no teste. A primeira versão deste
   * teste inseria a consulta com `select p.price_cents from app.procedures` — e aí provava
   * o meu SQL, não o caminho que a recepção usa. Uma mutação que tirasse o snapshot de
   * `agenda.criar` passaria verde.
   */
  it('o preço novo vale para a consulta nova, pela rota de marcar', async () => {
    await chamar('POST', `/api/procedimentos/${c.procEletivo}`, { corpo: { precoCents: 50_000 } });

    const paciente = c.patients[1];
    if (paciente === undefined) throw new Error('o cenário precisa de dois pacientes');
    const inicio = new Date(Date.now() + 86_400_000 * 2);
    const marcada = await chamar('POST', '/api/agenda', {
      corpo: {
        profissionalId: c.profA,
        pacienteId: paciente,
        procedimentoId: c.procEletivo,
        inicio: inicio.toISOString(),
      },
    });
    expect(marcada.statusCode).toBe(201);
    expect(marcada.json<{ price_cents: string }>().price_cents).toBe('50000');
  });

  /**
   * Remarcar NÃO reprecifica. A consulta carrega o preço do dia em que foi marcada, mesmo
   * que o cadastro tenha mudado no meio — senão arrastar um bloco na agenda viraria um
   * reajuste silencioso, e o paciente receberia uma cobrança diferente da combinada.
   */
  it('remarcar carrega o preço da consulta, não o do cadastro de hoje', async () => {
    const paciente = c.patients[2];
    if (paciente === undefined) throw new Error('o cenário precisa de três pacientes');
    const inicio = new Date(Date.now() + 86_400_000 * 3);
    const marcada = await chamar('POST', '/api/agenda', {
      corpo: {
        profissionalId: c.profA,
        pacienteId: paciente,
        procedimentoId: c.procEletivo,
        inicio: inicio.toISOString(),
      },
    });
    const id = marcada.json<{ id: string }>().id;

    // A clínica reajusta DEPOIS de marcar.
    await chamar('POST', `/api/procedimentos/${c.procEletivo}`, { corpo: { precoCents: 90_000 } });

    const novoInicio = new Date(Date.now() + 86_400_000 * 4);
    const remarcada = await chamar('POST', `/api/agenda/${id}/remarcar`, {
      corpo: { novoInicio: novoInicio.toISOString() },
    });
    expect(remarcada.statusCode).toBe(200);
    expect(
      remarcada.json<{ price_cents: string }>().price_cents,
      'remarcar reprecificou a consulta pelo cadastro de hoje',
    ).toBe('25000');
  });
});

describe('o procedimento da importação', () => {
  it('aparece marcado, e cadastrar o preço tira ele das pendências', async () => {
    await owner.query(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, source)
       values ($1, 'Da planilha', 30, 0, 'importado')`,
      [c.clinicA],
    );

    const antes = await listar();
    const daPlanilha = antes.procedimentos.find((p) => p.nome === 'Da planilha');
    expect(daPlanilha).toMatchObject({ daImportacao: true, semPreco: true });
    expect(antes.semPreco).toBe(1);

    await chamar('POST', `/api/procedimentos/${daPlanilha?.id ?? ''}`, {
      corpo: { precoCents: 18_000 },
    });

    const depois = await listar();
    expect(depois.semPreco, 'cadastrar o preço não tirou da lista de pendências').toBe(0);
    expect(depois.procedimentos.find((p) => p.nome === 'Da planilha')).toMatchObject({
      // Continua marcado como vindo da importação: isso é a origem, não uma pendência.
      daImportacao: true,
      semPreco: false,
      precoCents: 18_000,
    });
  });

  /**
   * A pendência desta tela é a MESMA pergunta que o Caixa faz. Se as duas discordassem, a
   * clínica cadastraria o preço aqui e o Caixa continuaria reclamando — ou o contrário.
   */
  it('a contagem de pendências bate com a do Caixa', async () => {
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, source)
       values ($1, 'Da planilha', 30, 0, 'importado') returning id`,
      [c.clinicA],
    );
    await owner.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4, now() + interval '1 day', now() + interval '1 day' + interval '30 minutes', 0)`,
      [c.clinicA, c.profA, paciente, rows[0]?.id],
    );

    const cadastro = await listar();
    const hoje = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
    const caixa = await chamar('GET', `/api/caixa?de=${hoje}&ate=${amanha}`);

    expect(cadastro.semPreco).toBe(caixa.json<RespostaCaixa>().semPreco.procedimentos.length);
  });

  it('cortesia cadastrada com preço zero NÃO é pendência', async () => {
    await owner.query(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Cortesia', 30, 0)`,
      [c.clinicA],
    );
    const { procedimentos, semPreco } = await listar();
    expect(procedimentos.find((p) => p.nome === 'Cortesia')).toMatchObject({
      daImportacao: false,
      semPreco: false,
    });
    expect(semPreco).toBe(0);
  });
});

describe('quem pode o quê', () => {
  it('quem cuida do financeiro edita', async () => {
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      userId: FINANCEIRO_DA_A,
      corpo: { precoCents: 30_000 },
    });
    expect(r.statusCode).toBe(200);
  });

  it('a recepção lê', async () => {
    const { podeEditar, procedimentos } = await listar({ userId: RECEPCAO_DA_A });
    expect(procedimentos.length).toBeGreaterThan(0);
    // E a tela sabe que não deve oferecer os campos de edição.
    expect(podeEditar).toBe(false);
  });

  it('a recepção não cadastra nem edita', async () => {
    const criar = await chamar('POST', '/api/procedimentos', {
      userId: RECEPCAO_DA_A,
      corpo: { nome: 'Da recepção', duracaoMinutos: 30, precoCents: 1000 },
    });
    expect(criar.statusCode).toBe(403);
    expect(criar.json()).toEqual({ erro: 'nao_edita_procedimento' });

    const editar = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      userId: RECEPCAO_DA_A,
      corpo: { precoCents: 1 },
    });
    expect(editar.statusCode).toBe(403);

    const inativar = await chamar('POST', `/api/procedimentos/${c.procEletivo}/ativo`, {
      userId: RECEPCAO_DA_A,
      corpo: { ativo: false },
    });
    expect(inativar.statusCode).toBe(403);

    // E nada se moveu.
    const { rows } = await owner.query<{ price_cents: string; active: boolean }>(
      'select price_cents, active from app.procedures where id = $1',
      [c.procEletivo],
    );
    expect(rows[0]).toMatchObject({ price_cents: '25000', active: true });
  });

  /** O teste que você nomeou: 403 entre clínicas na rota. */
  it('a dona da B não lê nem edita os procedimentos da A', async () => {
    const ler = await chamar('GET', '/api/procedimentos', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(ler.statusCode).toBe(403);
    expect(ler.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
    // E o corpo do 403 não conta nada sobre o cadastro da A.
    expect(ler.body).not.toContain('Limpeza');
    expect(ler.body).not.toContain('25000');

    const editar = await chamar('POST', `/api/procedimentos/${c.procEletivo}`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
      corpo: { precoCents: 1 },
    });
    expect(editar.statusCode).toBe(403);

    const { rows } = await owner.query<{ price_cents: string }>(
      'select price_cents from app.procedures where id = $1',
      [c.procEletivo],
    );
    expect(rows[0]?.price_cents, 'a clínica B mexeu no preço da A').toBe('25000');
  });

  it('pedindo a própria clínica, a B vê só os dela', async () => {
    const { procedimentos } = await listar({ userId: DONA_DA_B, clinica: c.clinicB });
    expect(procedimentos.map((p) => p.id)).not.toContain(c.procEletivo);
  });
});

describe('o retorno é característica do procedimento', () => {
  it('cadastra pedindo retorno e devolve o prazo na lista', async () => {
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: {
        nome: 'Harmonização de mandíbula',
        duracaoMinutos: 75,
        precoCents: 280000,
        retorno: { exige: true, emDias: 30 },
      },
    });
    expect(r.statusCode).toBe(201);

    const lista = await listar();
    const p = lista.procedimentos.find((x) => x.nome === 'Harmonização de mandíbula');
    expect(p?.retorno).toEqual({ exige: true, emDias: 30 });
  });

  it('quem não manda retorno fica sem pedir, e não com prazo zero', async () => {
    // O padrão é explícito nos dois lados: `.default({ exige: false })` no Zod e
    // `default false` na 0014. Prazo zero seria "retorno hoje", que é outra coisa.
    await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Clareamento caseiro', duracaoMinutos: 30, precoCents: 40000 },
    });
    const lista = await listar();
    expect(lista.procedimentos.find((x) => x.nome === 'Clareamento caseiro')?.retorno).toEqual({
      exige: false,
    });
  });

  it('pedir retorno sem dizer em quantos dias é 400, não erro de banco', async () => {
    // Sem a união discriminada isto chegaria ao check da 0014 e voltaria como violação de
    // constraint, que não é frase que se mostre a ninguém.
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: {
        nome: 'Sem prazo',
        duracaoMinutos: 30,
        precoCents: 1000,
        retorno: { exige: true },
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('prazo fora da faixa da migração é 400', async () => {
    for (const emDias of [0, 366, -5]) {
      const r = await chamar('POST', '/api/procedimentos', {
        corpo: {
          nome: `Fora da faixa ${String(emDias)}`,
          duracaoMinutos: 30,
          precoCents: 1000,
          retorno: { exige: true, emDias },
        },
      });
      expect(r.statusCode, `emDias=${String(emDias)}`).toBe(400);
    }
  });

  it('prazo quebrado é 400: dia e meio não é prazo de retorno', async () => {
    const r = await chamar('POST', '/api/procedimentos', {
      corpo: {
        nome: 'Prazo quebrado',
        duracaoMinutos: 30,
        precoCents: 1000,
        retorno: { exige: true, emDias: 1.5 },
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('editar troca o prazo, e editar para não pedir apaga o prazo', async () => {
    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: {
        nome: 'Peeling químico',
        duracaoMinutos: 45,
        precoCents: 45000,
        retorno: { exige: true, emDias: 15 },
      },
    });
    const { id } = criado.json<{ id: string }>();

    await chamar('POST', `/api/procedimentos/${id}`, {
      corpo: { retorno: { exige: true, emDias: 21 } },
    });
    let p = (await listar()).procedimentos.find((x) => x.id === id);
    expect(p?.retorno).toEqual({ exige: true, emDias: 21 });

    await chamar('POST', `/api/procedimentos/${id}`, { corpo: { retorno: { exige: false } } });
    p = (await listar()).procedimentos.find((x) => x.id === id);
    // Não basta `exige: false`: o prazo tem de sair do banco, ou o check da 0014 recusaria.
    expect(p?.retorno).toEqual({ exige: false });
  });

  it('a recepção não muda o retorno de ninguém', async () => {
    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Só a dona muda', duracaoMinutos: 30, precoCents: 1000 },
    });
    const { id } = criado.json<{ id: string }>();
    const r = await chamar('POST', `/api/procedimentos/${id}`, {
      userId: RECEPCAO_DA_A,
      corpo: { retorno: { exige: true, emDias: 10 } },
    });
    expect(r.statusCode).toBe(403);
  });

  it('o retorno de outra clínica não é editável nem visível', async () => {
    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: {
        nome: 'Da clínica A só',
        duracaoMinutos: 30,
        precoCents: 1000,
        retorno: { exige: true, emDias: 9 },
      },
    });
    const { id } = criado.json<{ id: string }>();

    const r = await chamar('POST', `/api/procedimentos/${id}`, {
      userId: DONA_DA_B,
      clinica: c.clinicB,
      corpo: { retorno: { exige: false } },
    });
    // 404 e não 403: para a clínica B este procedimento não existe, e dizer "sem permissão"
    // confirmaria que ele existe em algum lugar.
    expect(r.statusCode).toBe(404);

    const daB = await listar({ userId: DONA_DA_B, clinica: c.clinicB });
    expect(daB.procedimentos.map((p) => p.nome)).not.toContain('Da clínica A só');
  });
});

describe('o carimbo de quando o cadastro mudou', () => {
  async function carimbos(id: string): Promise<{ criado: Date; mudado: Date }> {
    const { rows } = await owner.query<{ created_at: Date; updated_at: Date }>(
      'select created_at, updated_at from app.procedures where id = $1',
      [id],
    );
    const linha = rows[0];
    expect(linha).toBeDefined();
    return { criado: linha?.created_at ?? new Date(0), mudado: linha?.updated_at ?? new Date(0) };
  }

  it('editar move o updated_at e deixa o created_at onde estava', async () => {
    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Carimbo na edição', duracaoMinutos: 30, precoCents: 10000 },
    });
    const { id } = criado.json<{ id: string }>();
    const antes = await carimbos(id);

    await chamar('POST', `/api/procedimentos/${id}`, { corpo: { precoCents: 12000 } });
    const depois = await carimbos(id);

    expect(depois.mudado.getTime()).toBeGreaterThan(antes.mudado.getTime());
    expect(depois.criado.getTime()).toBe(antes.criado.getTime());
  });

  it('inativar também é mudança de cadastro, e move o carimbo', async () => {
    // Sem isto, "o que mudou no cadastro desde ontem?" perderia justamente a mudança que
    // tira um procedimento da agenda.
    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Carimbo ao inativar', duracaoMinutos: 30, precoCents: 10000 },
    });
    const { id } = criado.json<{ id: string }>();
    const antes = await carimbos(id);

    await chamar('POST', `/api/procedimentos/${id}/ativo`, { corpo: { ativo: false } });
    const depois = await carimbos(id);
    expect(depois.mudado.getTime()).toBeGreaterThan(antes.mudado.getTime());
  });
});

describe('a duração cadastrada é a que a agenda reserva', () => {
  it('encurtar o procedimento encurta a consulta MARCADA DEPOIS', async () => {
    // O requisito "ends_at = starts_at + duração" não é uma função nova: é `agenda.criar`
    // lendo `duration_minutes` do cadastro. O que este teste prova é que a tela de
    // procedimentos alimenta esse caminho de verdade — editar aqui muda o que a agenda
    // reserva amanhã, que é o motivo de a recepção ter acesso de leitura a esta tela.
    const paciente = c.patients[3];
    if (paciente === undefined) throw new Error('o cenário precisa de quatro pacientes');

    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Avaliação rápida', duracaoMinutos: 60, precoCents: 15000 },
    });
    const { id: procedimentoId } = criado.json<{ id: string }>();

    await chamar('POST', `/api/procedimentos/${procedimentoId}`, {
      corpo: { duracaoMinutos: 25 },
    });

    const inicio = new Date(Date.now() + 86_400_000 * 9);
    const marcada = await chamar('POST', '/api/agenda', {
      corpo: {
        profissionalId: c.profA,
        pacienteId: paciente,
        procedimentoId,
        inicio: inicio.toISOString(),
      },
    });
    expect(marcada.statusCode).toBe(201);

    const { rows } = await owner.query<{ minutos: number }>(
      `select extract(epoch from (ends_at - starts_at)) / 60 as minutos
         from app.appointments where id = $1`,
      [marcada.json<{ id: string }>().id],
    );
    expect(Number(rows[0]?.minutos)).toBe(25);
  });

  it('a consulta JÁ MARCADA não muda de duração quando o cadastro muda', async () => {
    // O espelho do teste do preço: a consulta guarda a própria janela em starts_at/ends_at,
    // e mexer no cadastro não reescreve o passado nem a agenda de amanhã já combinada.
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário precisa de um paciente');

    const criado = await chamar('POST', '/api/procedimentos', {
      corpo: { nome: 'Sessão longa', duracaoMinutos: 90, precoCents: 30000 },
    });
    const { id: procedimentoId } = criado.json<{ id: string }>();

    const inicio = new Date(Date.now() + 86_400_000 * 10);
    const marcada = await chamar('POST', '/api/agenda', {
      corpo: {
        profissionalId: c.profA,
        pacienteId: paciente,
        procedimentoId,
        inicio: inicio.toISOString(),
      },
    });
    const consultaId = marcada.json<{ id: string }>().id;

    await chamar('POST', `/api/procedimentos/${procedimentoId}`, { corpo: { duracaoMinutos: 30 } });

    const { rows } = await owner.query<{ minutos: number }>(
      `select extract(epoch from (ends_at - starts_at)) / 60 as minutos
         from app.appointments where id = $1`,
      [consultaId],
    );
    expect(Number(rows[0]?.minutos)).toBe(90);
  });
});
