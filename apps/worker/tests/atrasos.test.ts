import { criarDb, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { TEMPLATES } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { varrerAtrasos, varrerClinica } from '../src/atrasos';
import { WhatsappFalso } from './fake';

let db: Db;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;
let proc120: string;
let proc60: string;

const PHONE_NUMBER_ID = '555000111222';

/** Hora local da Clínica A (America/Sao_Paulo) no dia 10/11/2026, em UTC. */
const L = (h: number, m = 0): Date => new Date(Date.UTC(2026, 10, 10, h + 3, m));

interface Marcacao {
  id?: string;
  paciente: string;
  inicio: Date;
  fim: Date;
  procedimento: string;
  status?: string;
  chegouEm?: Date;
  iniciadaEm?: Date;
  finalizadaEm?: Date;
}

async function marcar(m: Marcacao): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, status,
        price_cents, checked_in_at, started_at, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,25000,$8,$9,$10) returning id`,
    [
      c.clinicA,
      c.profA,
      m.paciente,
      m.procedimento,
      m.inicio,
      m.fim,
      m.status ?? 'confirmado',
      m.chegouEm ?? null,
      m.iniciadaEm ?? null,
      m.finalizadaEm ?? null,
    ],
  );
  return rows[0]!.id;
}

async function avisos(consultaId: string) {
  const { rows } = await owner.query<{ channel: string; delay_minutes: number }>(
    'select channel, delay_minutes from app.delay_notices where appointment_id = $1 order by sent_at',
    [consultaId],
  );
  return rows;
}

async function alertasDe(tipo: string) {
  const { rows } = await owner.query<{ title: string; body: string }>(
    'select title, body from app.alerts where kind = $1 order by created_at',
    [tipo],
  );
  return rows;
}

const dep = (agora: Date) => ({ db, whatsapp, agora: () => agora });

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id) values ($1, $2)`,
    [c.clinicA, PHONE_NUMBER_ID],
  );
  const criarProc = async (nome: string, minutos: number): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1,$2,$3,25000) returning id`,
      [c.clinicA, nome, minutos],
    );
    return rows[0]!.id;
  };
  proc120 = await criarProc('Procedimento longo', 120);
  proc60 = await criarProc('Procedimento curto', 60);
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  whatsapp = new WhatsappFalso();
  await owner.query('delete from app.delay_notices');
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.appointments');
  await owner.query('update app.patients set whatsapp_consent_at = now()');
  await owner.query('update app.clinics set active = true');
});

/**
 * O dia da Dra. Ana: o das 9h se estende, o das 11h ainda não começou e o das
 * 15h é quem recebe os avisos. É o cenário inteiro da fase em três relógios.
 */
async function diaQueAtrasa() {
  const c1 = await marcar({
    paciente: c.patients[0]!,
    inicio: L(9),
    fim: L(11),
    procedimento: proc120,
    iniciadaEm: L(9),
  });
  const c2 = await marcar({
    paciente: c.patients[1]!,
    inicio: L(11),
    fim: L(13),
    procedimento: proc120,
  });
  const c3 = await marcar({
    paciente: c.patients[2]!,
    inicio: L(15),
    fim: L(16),
    procedimento: proc60,
  });
  return { c1, c2, c3 };
}

describe('relógio simulado: aparece, cresce, some', () => {
  it('avisa, reavisa quando cresce 10 min e diz que normalizou quando o dia recupera', async () => {
    const { c1, c2, c3 } = await diaQueAtrasa();

    // T1 13:30 — o atraso aparece.
    const t1 = await varrerClinica(dep(L(13, 30)), c.clinicA);
    expect(t1.avisosAoPaciente).toBeGreaterThan(0);
    expect(await avisos(c3)).toEqual([{ channel: 'whatsapp', delay_minutes: 30 }]);

    // T1b 13:35 — nada mudou: variação pequena não vira mensagem nova.
    await varrerClinica(dep(L(13, 35)), c.clinicA);
    expect(await avisos(c3)).toHaveLength(1);

    // T2 13:50 — o atraso cresceu 20 min: reavisa.
    await varrerClinica(dep(L(13, 50)), c.clinicA);
    expect(await avisos(c3)).toEqual([
      { channel: 'whatsapp', delay_minutes: 30 },
      { channel: 'whatsapp', delay_minutes: 50 },
    ]);

    // T3 14:00 — o das 11h cancelou e o das 9h terminou: o dia recuperou.
    await owner.query(`update app.appointments set status = 'cancelado' where id = $1`, [c2]);
    await owner.query('update app.appointments set finished_at = $2 where id = $1', [
      c1,
      L(13, 55),
    ]);
    await varrerClinica(dep(L(14)), c.clinicA);

    expect(await avisos(c3)).toEqual([
      { channel: 'whatsapp', delay_minutes: 30 },
      { channel: 'whatsapp', delay_minutes: 50 },
      { channel: 'whatsapp', delay_minutes: 0 },
    ]);

    // O invariante que importa: NINGUÉM recebe "voltou ao normal" sem ter
    // recebido um aviso de atraso antes. Quem foi mandado chegar mais tarde
    // precisa saber que o horário original voltou a valer, ou perde a consulta.
    const avisadosDeAtraso = new Set(
      whatsapp.enviados.filter((e) => e.template === TEMPLATES.atraso.nome).map((e) => e.paraE164),
    );
    const normalizados = whatsapp.enviados
      .filter((e) => e.template === TEMPLATES.normalizou.nome)
      .map((e) => e.paraE164);
    expect(normalizados).not.toHaveLength(0);
    for (const numero of normalizados) expect(avisadosDeAtraso).toContain(numero);

    // E é o paciente das 15h, o dono da consulta que normalizou.
    const { rows } = await owner.query<{ phone_e164: string }>(
      'select phone_e164 from app.patients where id = $1',
      [c.patients[2]!],
    );
    expect(normalizados).toEqual([rows[0]!.phone_e164]);
  });
});

describe('quem recebe o quê', () => {
  it('o template de atraso leva os dois botões, e remarcar é o mesmo payload de sempre', async () => {
    await diaQueAtrasa();
    await varrerClinica(dep(L(13, 30)), c.clinicA);

    // O das 15h: o das 11h também é avisado, mas com outro atraso.
    const { rows } = await owner.query<{ phone_e164: string }>(
      'select phone_e164 from app.patients where id = $1',
      [c.patients[2]!],
    );
    const atraso = whatsapp.enviados.find(
      (e) => e.template === TEMPLATES.atraso.nome && e.paraE164 === rows[0]!.phone_e164,
    );
    // "Prefiro remarcar" cai no fluxo de remarcação, que não cobra taxa: o
    // atraso foi da clínica, e quem remarca não cancelou.
    expect(atraso?.botoes).toEqual(['CHEGO_MAIS_TARDE', 'REMARCAR_CONSULTA']);
    expect(atraso?.variaveis?.[0]).toBe('30');
  });

  it('quem já está na sala recebe alerta na recepção, não mensagem', async () => {
    const { c3 } = await diaQueAtrasa();
    await owner.query('update app.appointments set checked_in_at = $2 where id = $1', [
      c3,
      L(14, 30),
    ]);

    await varrerClinica(dep(L(13, 30)), c.clinicA);

    expect(await avisos(c3)).toEqual([{ channel: 'recepcao', delay_minutes: 30 }]);
    const paraOPaciente = whatsapp.enviados.filter(
      (e) => e.template === TEMPLATES.atraso.nome && e.variaveis?.[0] === '30',
    );
    expect(paraOPaciente).toHaveLength(0);
    expect(await alertasDe('atraso_profissional')).not.toHaveLength(0);
  });

  it('não manda o quarto aviso da mesma consulta', async () => {
    const { c3 } = await diaQueAtrasa();

    // A cada 20 minutos o atraso cresce 20: pelas regras de core, cada volta
    // mereceria um aviso novo. O teto é que segura.
    for (const t of [L(13, 30), L(13, 50), L(14, 10)]) {
      await varrerClinica(dep(t), c.clinicA);
    }
    expect(await avisos(c3)).toEqual([
      { channel: 'whatsapp', delay_minutes: 30 },
      { channel: 'whatsapp', delay_minutes: 50 },
      { channel: 'whatsapp', delay_minutes: 70 },
    ]);

    const antes = whatsapp.enviados.length;
    await varrerClinica(dep(L(14, 30)), c.clinicA);
    expect(await avisos(c3)).toHaveLength(3);
    expect(whatsapp.enviados).toHaveLength(antes);
  });

  it('fora da janela da clínica não avisa ninguém', async () => {
    const { c3 } = await diaQueAtrasa();
    // Janela de 1 hora: às 13:30 a consulta das 15h está longe demais.
    await owner.query('update app.clinics set delay_notice_window_hours = 1 where id = $1', [
      c.clinicA,
    ]);
    await varrerClinica(dep(L(13, 30)), c.clinicA);
    expect(await avisos(c3)).toEqual([]);
    await owner.query('update app.clinics set delay_notice_window_hours = 3 where id = $1', [
      c.clinicA,
    ]);
  });

  it('sem consentimento não envia, e não gasta a cota de avisos', async () => {
    const { c3 } = await diaQueAtrasa();
    await owner.query('update app.patients set whatsapp_consent_at = null where id = $1', [
      c.patients[2]!,
    ]);

    await varrerClinica(dep(L(13, 30)), c.clinicA);

    expect(await avisos(c3)).toEqual([]);
  });

  it('sem consentimento, a recepção sabe que foi do atraso que ninguém avisou', async () => {
    await diaQueAtrasa();
    await owner.query('update app.patients set whatsapp_consent_at = null where id = $1', [
      c.patients[2]!,
    ]);
    const { rows } = await owner.query<{ name: string }>(
      'select name from app.patients where id = $1',
      [c.patients[2]!],
    );

    await varrerClinica(dep(L(13, 30)), c.clinicA);

    // Genérico demais ("mensagem não enviada") faz a recepção adivinhar o que
    // era. Aqui ela tem nome e assunto: liga e resolve.
    const alertas = await alertasDe('sem_consentimento');
    const doPaciente = alertas.find((a) => a.title.includes(rows[0]!.name));
    expect(doPaciente?.title).toBe(
      `Não foi possível avisar ${rows[0]!.name} do atraso — sem consentimento de WhatsApp`,
    );
    expect(doPaciente?.body).toContain('Ligue para');
  });
});

describe('sala de espera', () => {
  it('alerta quem espera além da tolerância da clínica', async () => {
    const espera = await marcar({
      paciente: c.patients[3]!,
      inicio: L(13),
      fim: L(14),
      procedimento: proc60,
      chegouEm: L(12, 50),
    });

    await varrerClinica(dep(L(13, 40)), c.clinicA);

    const alertas = await alertasDe('espera_longa');
    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.title).toContain('40 min');
    expect(espera).toBeTruthy();
  });

  it('dentro da tolerância não alerta', async () => {
    await marcar({
      paciente: c.patients[3]!,
      inicio: L(13),
      fim: L(14),
      procedimento: proc60,
      chegouEm: L(12, 50),
    });
    await varrerClinica(dep(L(13, 5)), c.clinicA);
    expect(await alertasDe('espera_longa')).toEqual([]);
  });
});

describe('quais clínicas entram na varredura', () => {
  /**
   * "Hoje" é o hoje do banco: a função usa now(), como tem de ser em produção.
   * Por isso estes casos marcam consulta no dia de verdade, não no dia fixo do
   * relógio simulado.
   */
  async function consultaHoje(): Promise<void> {
    await owner.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4, date_trunc('day', now()) + interval '15 hours',
               date_trunc('day', now()) + interval '16 hours', 25000)`,
      [c.clinicA, c.profA, c.patients[0]!, proc60],
    );
  }

  it('a clínica com atendimento hoje entra', async () => {
    await consultaHoje();
    const r = await varrerAtrasos({ db, whatsapp });
    expect(r.clinicas).toBe(1);
  });

  it('clínica suspensa fica de fora', async () => {
    await consultaHoje();
    await owner.query('update app.clinics set active = false where id = $1', [c.clinicA]);
    const r = await varrerAtrasos({ db, whatsapp });
    expect(r.clinicas).toBe(0);
  });

  it('consulta cancelada não põe a clínica na varredura', async () => {
    await consultaHoje();
    await owner.query(`update app.appointments set status = 'cancelado'`);
    const r = await varrerAtrasos({ db, whatsapp });
    expect(r.clinicas).toBe(0);
  });

  it('a função da varredura devolve só o id da clínica, nada mais', async () => {
    // O tipo de retorno é a garantia de que nenhum dado de uma clínica vaza
    // para o worker antes de a RLS entrar em cena.
    const { rows } = await owner.query<{ tipo: string; devolve_conjunto: boolean }>(
      `select pg_get_function_result(p.oid) as tipo, p.proretset as devolve_conjunto
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'clinics_with_appointments_today'`,
    );
    expect(rows[0]).toEqual({ tipo: 'SETOF uuid', devolve_conjunto: true });
  });

  it('é security definer, stable, e só fliqo_app executa', async () => {
    const { rows } = await owner.query<{
      seguranca: boolean;
      volatilidade: string;
      busca: string[] | null;
      permissoes: string | null;
    }>(
      `select p.prosecdef as seguranca, p.provolatile as volatilidade, p.proconfig as busca,
              array_to_string(p.proacl::text[], ',') as permissoes
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'clinics_with_appointments_today'`,
    );
    expect(rows[0]?.seguranca).toBe(true);
    expect(rows[0]?.volatilidade).toBe('s'); // stable
    expect(rows[0]?.busca).toEqual(['search_path=app, pg_temp']);
    expect(rows[0]?.permissoes).toContain('fliqo_app=X');
    expect(rows[0]?.permissoes).not.toMatch(/(^|,)=X/); // public não executa
  });
});

describe('isolamento', () => {
  it('a varredura de uma clínica não enxerga consulta de outra', async () => {
    await marcar({ paciente: c.patients[0]!, inicio: L(15), fim: L(16), procedimento: proc60 });
    const visiveis = await withClinic(
      c.clinicB,
      async (trx) => {
        const { atrasos } = await import('@fliqo/db');
        return atrasos.consultasDoDia(trx, L(0), L(23, 59));
      },
      db,
    );
    expect(visiveis).toEqual([]);
  });
});
