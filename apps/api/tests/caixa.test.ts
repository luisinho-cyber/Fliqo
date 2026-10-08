import {
  AMOSTRA_MINIMA_DE_COMPARECIMENTO,
  formatBRL,
  resumirCaixa,
  type ConsultaNoCaixa,
  type HistoricoDeComparecimento,
} from '@fliqo/core';
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

/**
 * O caixa: marcado × esperado × realizado.
 *
 * É dinheiro, então o teste que mais importa não é o 403: é o que compara os números da
 * rota com os da regra pura de packages/core, no MESMO cenário. Se eles divergirem, foi a
 * rota que começou a calcular por conta — e a regra deixou de ser a fonte.
 */

const JWT_SECRET = 'segredo-jwt-do-caixa';
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
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 6).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

/** O dia do cenário, escolhido longe de hoje para o teste não depender do calendário. */
const DIA = '2027-03-10';

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(segredo);
}

async function chamar(
  url: string,
  o: { userId: string; clinica: string },
): Promise<LightMyRequestResponse> {
  const opcoes: InjectOptions = {
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${await token(o.userId)}`, 'x-clinica': o.clinica },
  };
  return app.inject(opcoes);
}

async function doCaixa(
  o: { userId?: string; clinica?: string; de?: string; ate?: string } = {},
): Promise<LightMyRequestResponse> {
  const de = o.de ?? DIA;
  const ate = o.ate ?? DIA;
  return chamar(`/api/caixa?de=${de}&ate=${ate}`, {
    userId: o.userId ?? DONA_DA_A,
    clinica: o.clinica ?? c.clinicA,
  });
}

interface Semeada {
  status: 'agendado' | 'confirmado' | 'em_risco' | 'cancelado' | 'faltou' | 'realizado';
  preco: number;
  hora: number;
  profissional?: string;
  procedimento?: string;
  dia?: string;
  /** Para o caso do procedimento importado com preço zero. */
  origemDoProcedimento?: 'cadastro' | 'importado';
}

/** O mesmo cenário no banco e na regra pura: é a comparação entre os dois que importa. */
async function semear(linhas: Semeada[]): Promise<ConsultaNoCaixa[]> {
  const paraCore: ConsultaNoCaixa[] = [];
  for (const [i, l] of linhas.entries()) {
    const profissional = l.profissional ?? c.profA;
    let procedimento = l.procedimento ?? c.procEletivo;

    if (l.origemDoProcedimento === 'importado') {
      const { rows } = await owner.query<{ id: string }>(
        `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, source)
         values ($1, $2, 30, 0, 'importado') returning id`,
        [c.clinicA, `Da planilha ${String(i)}`],
      );
      procedimento = rows[0]?.id ?? '';
    }

    const paciente = c.patients[i % c.patients.length];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');

    await owner.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status)
       values ($1, $2, $3, $4,
               (($5 || ' ' || $6 || ':00')::timestamp at time zone 'America/Sao_Paulo'),
               (($5 || ' ' || $6 || ':00')::timestamp at time zone 'America/Sao_Paulo')
                 + interval '30 minutes',
               $7, $8)`,
      [
        c.clinicA,
        profissional,
        paciente,
        procedimento,
        l.dia ?? DIA,
        String(l.hora).padStart(2, '0'),
        l.preco,
        l.status,
      ],
    );

    paraCore.push({
      profissionalId: profissional,
      procedimentoId: procedimento,
      status: l.status,
      preco: l.preco,
      precoCadastrado: !(l.origemDoProcedimento === 'importado' && l.preco === 0),
    });
  }
  return paraCore;
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
  // Um segundo profissional, para as linhas por profissional terem o que separar.
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.professionals (clinic_id, name) values ($1, 'Dra. Bia') returning id`,
    [c.clinicA],
  );
  c = { ...c, profB: rows[0]?.id ?? '' } as Scenario & { profB: string };

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

/**
 * Dá à clínica A um histórico de comparecimento acima do piso.
 *
 * São consultas PASSADAS com desfecho: é delas que a taxa sai. Sem isto a clínica é nova e
 * o caixa se recusa a projetar — que é o comportamento certo, e tem teste próprio.
 */
async function comHistorico(o: {
  confirmadas: number;
  compareceramConfirmadas: number;
  semConfirmar: number;
  compareceramSemConfirmar: number;
}): Promise<void> {
  const paciente = c.patients[0];
  if (paciente === undefined) throw new Error('o cenário não tem paciente');

  let hora = 0;
  const criar = async (quantas: number, veio: number, confirmada: boolean) => {
    for (let i = 0; i < quantas; i++) {
      const status = i < veio ? 'realizado' : 'faltou';
      // Espalhadas no passado, uma por hora, para não bater no no_double_booking.
      await owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
            price_cents, status, confirmed_at)
         values ($1, $2, $3, $4,
                 now() - make_interval(hours => $5::int),
                 now() - make_interval(hours => $5::int) + interval '30 minutes',
                 25000, $6, $7)`,
        [
          c.clinicA,
          c.profA,
          paciente,
          c.procEletivo,
          hora + 1,
          status,
          confirmada ? new Date() : null,
        ],
      );
      hora++;
    }
  };
  await criar(o.confirmadas, o.compareceramConfirmadas, true);
  await criar(o.semConfirmar, o.compareceramSemConfirmar, false);
}

/** O histórico equivalente, para comparar a rota com a regra pura. */
function historicoDe(o: {
  confirmadas: number;
  compareceramConfirmadas: number;
  semConfirmar: number;
  compareceramSemConfirmar: number;
}): HistoricoDeComparecimento {
  return {
    confirmada: { total: o.confirmadas, compareceram: o.compareceramConfirmadas },
    sem_confirmacao: { total: o.semConfirmar, compareceram: o.compareceramSemConfirmar },
    janelaDias: 90,
  };
}

const HISTORICO_FOLGADO = {
  confirmadas: 40,
  compareceramConfirmadas: 38,
  semConfirmar: 40,
  compareceramSemConfirmar: 32,
};

beforeEach(async () => {
  await owner.query('delete from app.appointments');
  await owner.query(`delete from app.procedures where source = 'importado'`);
  await owner.query('update app.clinics set guest_mode = false');
});

describe('os números da rota são os da regra', () => {
  /**
   * O teste central. Se a rota e `resumirCaixa` divergirem em um centavo, foi a rota que
   * começou a calcular por conta — e a regra deixou de ser a fonte do número.
   */
  it('batem centavo por centavo com resumirCaixa no mesmo cenário', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    const paraCore = await semear([
      { status: 'realizado', preco: 25_000, hora: 8 },
      { status: 'confirmado', preco: 90_000, hora: 9 },
      { status: 'agendado', preco: 25_000, hora: 10 },
      { status: 'em_risco', preco: 150_000, hora: 11 },
      { status: 'faltou', preco: 25_000, hora: 12 },
      { status: 'cancelado', preco: 150_000, hora: 13 },
    ]);
    const esperado = resumirCaixa(paraCore, historicoDe(HISTORICO_FOLGADO));

    const r = await doCaixa();
    expect(r.statusCode).toBe(200);
    const corpo = r.json<RespostaCaixa>();

    expect(corpo.marcadoCents).toBe(esperado.marcadoCents);
    expect(corpo.esperadoCents).toBe(esperado.esperadoCents);
    expect(corpo.realizadoCents).toBe(esperado.realizadoCents);
    expect(corpo.consultas).toBe(esperado.consultas);
    expect(corpo.faltas).toEqual({
      quantidade: esperado.faltas.quantidade,
      valorCents: esperado.faltas.valor,
    });
  });

  it('as linhas da resposta somam o total da manchete', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([
      { status: 'confirmado', preco: 90_000, hora: 9 },
      { status: 'agendado', preco: 25_000, hora: 10, profissional: c.profA },
      { status: 'realizado', preco: 150_000, hora: 11, procedimento: c.procLongo },
    ]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();

    expect(corpo.esperadoCents, 'o cenário tem histórico: nulo aqui é defeito').not.toBeNull();
    for (const eixo of [corpo.porProfissional, corpo.porProcedimento]) {
      expect(eixo.reduce((s, l) => s + l.marcadoCents, 0)).toBe(corpo.marcadoCents);
      expect(eixo.reduce((s, l) => s + (l.esperadoCents ?? Number.NaN), 0)).toBe(
        corpo.esperadoCents,
      );
      expect(eixo.reduce((s, l) => s + l.realizadoCents, 0)).toBe(corpo.realizadoCents);
    }
  });

  it('todo valor devolvido é inteiro em centavos', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([
      { status: 'confirmado', preco: 33_333, hora: 9 },
      { status: 'em_risco', preco: 7, hora: 10 },
    ]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    const todos = [
      corpo.marcadoCents,
      corpo.esperadoCents ?? Number.NaN,
      corpo.realizadoCents,
      corpo.faltas.valorCents,
      ...corpo.porProfissional.flatMap((l) => [
        l.marcadoCents,
        l.esperadoCents ?? Number.NaN,
        l.realizadoCents,
      ]),
    ];
    for (const v of todos) expect(Number.isSafeInteger(v), `${String(v)} não é inteiro`).toBe(true);
  });

  /**
   * A frase é montada com o `formatBRL` do core, e não com um literal digitado: o
   * `Intl` põe espaço NÃO SEPARÁVEL entre "R$" e o número, e um literal com espaço comum
   * passa a vida parecendo igual e falhando. O que o teste fixa é a FORMA da frase.
   */
  it('a manchete diz os dois números, a distância E a procedência', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([{ status: 'confirmado', preco: 100_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    // 38/40 das confirmadas desta clínica = 95%. 95% de 1.000,00 = 950,00.
    expect(corpo.manchete).toContain(
      `${formatBRL(100_000)} marcados, ${formatBRL(95_000)} esperados.`,
    );
    expect(corpo.manchete).toContain(`${formatBRL(5_000)} de distância`);
    // A procedência na PRÓPRIA frase: número sem origem não se defende para o sócio.
    expect(corpo.manchete, 'a frase não diz de onde veio a taxa').toContain(
      'sua taxa de comparecimento em 40 atendimentos dos últimos 90 dias',
    );
  });

  it('período sem consulta tem frase própria, não R$ 0,00', async () => {
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.manchete).toContain('Nenhuma consulta');
    expect(corpo.marcadoCents).toBe(0);
  });
});

describe('o que não conta', () => {
  it('consulta cancelada não conta como esperada', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([{ status: 'cancelado', preco: 150_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.esperadoCents).toBe(0);
    // E nem como marcada: o horário voltou a estar livre.
    expect(corpo.marcadoCents).toBe(0);
    expect(corpo.consultas).toBe(0);
  });

  it('consulta que faltou não conta como realizada', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([{ status: 'faltou', preco: 25_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.realizadoCents).toBe(0);
    expect(corpo.esperadoCents).toBe(0);
    // Mas continua marcada: é a distância que mostra o que a falta custou.
    expect(corpo.marcadoCents).toBe(25_000);
    expect(corpo.faltas).toEqual({ quantidade: 1, valorCents: 25_000 });
  });

  /**
   * O que veio do #27: procedimento criado pela importação entra com preço zero, e somar
   * isso como receita esperada de R$ 0 faria a tela mentir com cara de verde.
   */
  it('procedimento com preço zero da importação não entra na soma, e é contado', async () => {
    await comHistorico(HISTORICO_FOLGADO);
    await semear([
      { status: 'confirmado', preco: 90_000, hora: 9 },
      { status: 'confirmado', preco: 0, hora: 10, origemDoProcedimento: 'importado' },
      { status: 'realizado', preco: 0, hora: 11, origemDoProcedimento: 'importado' },
    ]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();

    expect(corpo.consultas, 'a consulta sem preço entrou na contagem').toBe(1);
    expect(corpo.marcadoCents).toBe(90_000);
    expect(corpo.semPreco.consultas).toBe(2);
    expect(corpo.semPreco.procedimentos).toHaveLength(2);
    // E a tela recebe o nome para poder levar ao cadastro.
    expect(corpo.semPreco.procedimentos[0]?.nome).toContain('Da planilha');
    // Não aparecem nas linhas: "2 consultas, R$ 0" leria como receita zero.
    expect(corpo.porProcedimento).toHaveLength(1);
  });

  it('cortesia cadastrada com preço zero entra na conta e não vira pendência', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Cortesia', 30, 0) returning id`,
      [c.clinicA],
    );
    const cortesia = rows[0]?.id;
    if (cortesia === undefined) throw new Error('o cenário não criou a cortesia');
    await semear([{ status: 'realizado', preco: 0, hora: 9, procedimento: cortesia }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.consultas).toBe(1);
    expect(corpo.semPreco.procedimentos).toEqual([]);
  });

  it('consulta de outro dia fica fora da janela', async () => {
    await semear([
      { status: 'confirmado', preco: 90_000, hora: 9 },
      { status: 'confirmado', preco: 777_000, hora: 9, dia: '2027-03-11' },
    ]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.marcadoCents).toBe(90_000);
  });

  /**
   * A janela é dia de calendário no fuso da CLÍNICA. Uma consulta às 22h de São Paulo é
   * 01h do dia seguinte em UTC: uma janela montada em UTC a jogaria para o dia errado, e a
   * semana fecharia com o número errado sem ninguém perceber.
   */
  it('consulta da noite não escorrega para o dia seguinte', async () => {
    await semear([{ status: 'confirmado', preco: 90_000, hora: 22 }]);
    expect((await doCaixa()).json<RespostaCaixa>().marcadoCents).toBe(90_000);
    expect(
      (await doCaixa({ de: '2027-03-11', ate: '2027-03-11' })).json<RespostaCaixa>().marcadoCents,
      'a consulta das 22h vazou para o dia seguinte',
    ).toBe(0);
  });

  it('a janela inclui o último dia inteiro', async () => {
    await semear([{ status: 'confirmado', preco: 90_000, hora: 23, dia: '2027-03-12' }]);
    const corpo = (await doCaixa({ de: DIA, ate: '2027-03-12' })).json<RespostaCaixa>();
    expect(corpo.marcadoCents).toBe(90_000);
  });
});

describe('quem vê o caixa', () => {
  it('a dona vê', async () => {
    expect((await doCaixa()).statusCode).toBe(200);
  });

  it('quem cuida do financeiro vê', async () => {
    expect((await doCaixa({ userId: FINANCEIRO_DA_A })).statusCode).toBe(200);
  });

  it('a recepção não vê o faturamento da clínica', async () => {
    const r = await doCaixa({ userId: RECEPCAO_DA_A });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'nao_ve_o_caixa' });
  });

  it('a dona da B não vê o caixa da A, e o corpo não conta nada', async () => {
    await semear([{ status: 'confirmado', preco: 123_456, hora: 9 }]);
    const r = await doCaixa({ userId: DONA_DA_B });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
    // Nenhum número da clínica A no corpo do 403 — nem o total, nem um pedaço dele.
    expect(r.body).not.toContain('123456');
    expect(r.body).not.toContain('1.234,56');
    expect(r.body).not.toContain('marcados');
  });

  it('pedir a própria clínica não mostra o caixa da outra', async () => {
    await semear([{ status: 'confirmado', preco: 123_456, hora: 9 }]);
    const r = await doCaixa({ userId: DONA_DA_B, clinica: c.clinicB });
    expect(r.statusCode).toBe(200);
    // A RLS não acha as consultas da A: para a clínica B elas não existem.
    expect(r.json<RespostaCaixa>().marcadoCents).toBe(0);
  });

  it('data inválida é recusada antes do banco', async () => {
    const r = await chamar('/api/caixa?de=ontem', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.statusCode).toBe(400);
  });

  it('janela invertida é recusada', async () => {
    const r = await doCaixa({ de: '2027-03-20', ate: '2027-03-10' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ erro: 'janela_invertida' });
  });
});

describe('modo convidado não tem caixa', () => {
  /**
   * A condição que veio do #27, e ela é sobre a ROTA. Aba escondida com rota aberta é
   * falso-verde: a guarda conferiria a tela, não o acesso.
   */
  it('a clínica em modo convidado toma 403 na rota, com o motivo', async () => {
    await semear([{ status: 'confirmado', preco: 123_456, hora: 9 }]);
    await owner.query('update app.clinics set guest_mode = true where id = $1', [c.clinicA]);

    const r = await doCaixa();
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'recurso_do_modo_proprio', recurso: 'financeiro' });
    // E nenhum número vaza no corpo da recusa.
    expect(r.body).not.toContain('123456');
    expect(r.body).not.toContain('marcados');
  });

  it('vale para quem cuida do financeiro também: não é questão de papel', async () => {
    await owner.query('update app.clinics set guest_mode = true where id = $1', [c.clinicA]);
    const r = await doCaixa({ userId: FINANCEIRO_DA_A });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'recurso_do_modo_proprio', recurso: 'financeiro' });
  });

  it('desligar o modo convidado devolve o caixa', async () => {
    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    await owner.query('update app.clinics set guest_mode = true where id = $1', [c.clinicA]);
    expect((await doCaixa()).statusCode).toBe(403);

    await owner.query('update app.clinics set guest_mode = false where id = $1', [c.clinicA]);
    expect((await doCaixa()).json<RespostaCaixa>().marcadoCents).toBe(90_000);
  });
});

describe('clínica nova: o esperado não inventa', () => {
  /**
   * A condição que bloqueava o merge, de ponta a ponta.
   *
   * Antes desta fase o esperado era preço × constante escrita no código. Clínica nova com
   * doze consultas recebia "R$ 11.200 esperados" com a mesma cara de número medido da
   * clínica com dois anos de histórico — e o dono só descobria conferindo contra o extrato.
   */
  it('sem nenhum atendimento passado, o esperado vem nulo e o marcado continua', async () => {
    // Nenhum `comHistorico`: a clínica é nova.
    await semear([
      { status: 'confirmado', preco: 90_000, hora: 9 },
      { status: 'agendado', preco: 25_000, hora: 10 },
    ]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();

    expect(corpo.marcadoCents).toBe(115_000);
    expect(corpo.esperadoCents, 'a clínica nova recebeu esperado chutado').toBeNull();
    expect(corpo.procedencia).toEqual({
      ha: false,
      motivo: 'sem_historico',
      amostra: 0,
      minimo: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
    });
  });

  it('a manchete diz que falta histórico, e quanto falta', async () => {
    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.manchete).toContain(`${formatBRL(90_000)} marcados`);
    expect(corpo.manchete).toContain('não há histórico');
    expect(corpo.manchete).toContain(String(AMOSTRA_MINIMA_DE_COMPARECIMENTO));
    // E NÃO afirma um esperado.
    expect(corpo.manchete).not.toContain('esperados');
  });

  it('as linhas também vêm sem esperado, não com zero', async () => {
    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.porProfissional).toHaveLength(1);
    for (const l of [...corpo.porProfissional, ...corpo.porProcedimento]) {
      expect(l.esperadoCents).toBeNull();
      expect(l.marcadoCents).toBe(90_000);
    }
  });

  /** Um a menos que o piso ainda é ruído. O limite é fechado e vale conferir nos dois lados. */
  it(`com ${String(AMOSTRA_MINIMA_DE_COMPARECIMENTO - 1)} atendimentos ainda não projeta`, async () => {
    await comHistorico({
      confirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO - 1,
      compareceramConfirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO - 1,
      semConfirmar: 0,
      compareceramSemConfirmar: 0,
    });
    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.esperadoCents).toBeNull();
  });

  it(`com ${String(AMOSTRA_MINIMA_DE_COMPARECIMENTO)} já projeta, com a taxa medida`, async () => {
    await comHistorico({
      confirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
      // 27 de 30 = 90%, que é a taxa DESTA clínica e de nenhuma outra.
      compareceramConfirmadas: 27,
      semConfirmar: 0,
      compareceramSemConfirmar: 0,
    });
    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(corpo.esperadoCents).toBe(81_000);
    expect(corpo.procedencia).toMatchObject({ ha: true, amostra: 30, janelaDias: 90 });
  });

  /**
   * Consulta passada que a recepção nunca marcou não é falta: é registro que não aconteceu.
   * Contá-la como não comparecimento rebaixaria a taxa por desleixo em vez de por
   * comportamento de paciente — e a taxa é o número que o dono vai defender.
   */
  it('consulta passada sem desfecho não entra no histórico', async () => {
    await comHistorico({
      confirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
      compareceramConfirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
      semConfirmar: 0,
      compareceramSemConfirmar: 0,
    });
    // Dez consultas de ontem ainda em `agendado`: ninguém tocou nelas.
    const paciente = c.patients[1];
    if (paciente === undefined) throw new Error('o cenário precisa de dois pacientes');
    for (let i = 0; i < 10; i++) {
      await owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
         values ($1,$2,$3,$4,
                 now() - make_interval(hours => $5::int),
                 now() - make_interval(hours => $5::int) + interval '30 minutes', 25000)`,
        [c.clinicA, c.profA, paciente, c.procEletivo, 200 + i],
      );
    }

    await semear([{ status: 'confirmado', preco: 100_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    // A taxa continua 100% das trinta confirmadas, não 30/40.
    expect(corpo.esperadoCents).toBe(100_000);
    expect(corpo.procedencia).toMatchObject({ amostra: 30 });
  });

  /**
   * Cancelada NÃO conta no denominador.
   *
   * O horário cancelado com aviso volta para a agenda, e a consulta que o reencaixa já está
   * na amostra — contar a cancelada é contar o mesmo horário duas vezes, e a segunda vez é
   * sempre contra a clínica. O erro cresce com a qualidade: arrancar aviso antecipado é o
   * que a régua de confirmação faz, e cada aviso conquistado derrubaria a taxa medida.
   *
   * A conta em packages/db/tests/comparecimento.test.ts; aqui o que se prova é que a rota
   * entrega esse número, e não um recalculado no caminho.
   */
  it('cancelada passada não entra no denominador do histórico', async () => {
    const paciente = c.patients[2];
    if (paciente === undefined) throw new Error('o cenário precisa de três pacientes');
    await comHistorico({
      confirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
      compareceramConfirmadas: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
      semConfirmar: 0,
      compareceramSemConfirmar: 0,
    });
    // Dez confirmadas e canceladas depois. A clínica não perdeu nada: avisaram.
    for (let i = 0; i < 10; i++) {
      await owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
            price_cents, status, confirmed_at, cancelled_at)
         values ($1,$2,$3,$4,
                 now() - make_interval(hours => $5::int),
                 now() - make_interval(hours => $5::int) + interval '30 minutes',
                 25000, 'cancelado', now(), now())`,
        [c.clinicA, c.profA, paciente, c.procEletivo, 300 + i],
      );
    }

    await semear([{ status: 'confirmado', preco: 100_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    // 30 de 30 = 100%. As dez canceladas não entram, e por isso a amostra continua 30: a
    // versão que as contava devolvia 75% e uma amostra de 40.
    expect(corpo.esperadoCents).toBe(100_000);
    expect(corpo.procedencia).toMatchObject({ amostra: 30 });
  });

  it('o histórico é da clínica, não do vizinho', async () => {
    // A clínica B ganha histórico; a A continua nova.
    const pacienteB = c.patientB;
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.professionals (clinic_id, name) values ($1, 'Dr. B') returning id`,
      [c.clinicB],
    );
    const { rows: proc } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Limpeza B', 30, 20000) returning id`,
      [c.clinicB],
    );
    for (let i = 0; i < 50; i++) {
      await owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
            price_cents, status, confirmed_at)
         values ($1,$2,$3,$4,
                 now() - make_interval(hours => $5::int),
                 now() - make_interval(hours => $5::int) + interval '30 minutes',
                 20000, 'realizado', now())`,
        [c.clinicB, rows[0]?.id, pacienteB, proc[0]?.id, 400 + i],
      );
    }

    await semear([{ status: 'confirmado', preco: 90_000, hora: 9 }]);
    const corpo = (await doCaixa()).json<RespostaCaixa>();
    expect(
      corpo.esperadoCents,
      'a clínica A projetou com o histórico da B: a RLS não está isolando o histórico',
    ).toBeNull();
  });
});
