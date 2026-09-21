import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criarDb, type Db } from '../src/conexao';
import { withClinic } from '../src/withClinic';
import * as agenda from '../src/repos/agenda';
import * as conversas from '../src/repos/conversas';
import * as fila from '../src/repos/fila';
import * as pacientes from '../src/repos/pacientes';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from './helpers';

let db: Db;
let owner: pg.Pool;
let c: Scenario;

/** Base longe o bastante para a régua de confirmação caber inteira no futuro. */
const BASE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const emHoras = (h: number): Date => new Date(BASE.getTime() + h * 60 * 60 * 1000);

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  db = criarDb(urlDoTester());
}, 60_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

describe('withClinic', () => {
  it('só enxerga a clínica da transação', async () => {
    const naA = await withClinic(
      c.clinicA,
      (trx) => trx.selectFrom('app.patients').select(['id']).execute(),
      db,
    );
    const naB = await withClinic(
      c.clinicB,
      (trx) => trx.selectFrom('app.patients').select(['id']).execute(),
      db,
    );

    expect(naA).toHaveLength(4);
    expect(naB).toHaveLength(1);
    expect(naA.map((p) => p.id)).not.toContain(c.patientB);
  });

  it('não deixa o tenant vazar para a próxima transação na mesma conexão', async () => {
    // set_config(..., true) é local à transação. Se não fosse, esta leitura sem
    // clínica devolveria os pacientes da clínica A.
    await withClinic(
      c.clinicA,
      async (trx) => {
        await trx.selectFrom('app.patients').select(['id']).execute();
      },
      db,
    );

    const semClinica = await db.selectFrom('app.patients').select(['id']).execute();
    expect(semClinica).toHaveLength(0);
  });

  it('recusa clinicId que não é uuid antes de tocar no banco', async () => {
    await expect(withClinic('nao-e-uuid', () => Promise.resolve(1), db)).rejects.toThrow(TypeError);
  });
});

describe('agenda', () => {
  it('marca e fotografa preço e duração do procedimento', async () => {
    const r = await withClinic(
      c.clinicA,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: c.profA,
          pacienteId: c.patients[0]!,
          procedimentoId: c.procEletivo,
          inicio: emHoras(0),
        }),
      db,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.consulta.price_cents).toBe('25000');
    // Limpeza: 60 minutos.
    expect(r.consulta.ends_at.getTime() - r.consulta.starts_at.getTime()).toBe(60 * 60_000);
    expect(r.consulta.status).toBe('agendado');
  });

  it('recusa horário já ocupado sem derrubar a transação', async () => {
    const r = await withClinic(
      c.clinicA,
      async (trx) => {
        const conflito = await agenda.criar(trx, {
          profissionalId: c.profA,
          pacienteId: c.patients[1]!,
          procedimentoId: c.procEletivo,
          inicio: emHoras(0),
        });
        // A transação continua utilizável depois do conflito — é o savepoint funcionando.
        const quantas = await trx
          .selectFrom('app.appointments')
          .select(['id'])
          .where('starts_at', '=', emHoras(0))
          .execute();
        return { conflito, quantas: quantas.length };
      },
      db,
    );

    expect(r.conflito).toEqual({ ok: false, motivo: 'horario_ocupado' });
    expect(r.quantas).toBe(1);
  });

  it('remarcar para horário livre cancela a antiga e cria a nova', async () => {
    const original = await withClinic(
      c.clinicA,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: c.profA,
          pacienteId: c.patients[2]!,
          procedimentoId: c.procEletivo,
          inicio: emHoras(10),
        }),
      db,
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const r = await withClinic(
      c.clinicA,
      (trx) => agenda.remarcar(trx, original.consulta.id, emHoras(12)),
      db,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const antiga = await withClinic(
      c.clinicA,
      (trx) => agenda.porId(trx, original.consulta.id),
      db,
    );
    expect(antiga?.status).toBe('cancelado');
    expect(antiga?.cancel_reason).toBe('remarcada');
    expect(r.consulta.starts_at.getTime()).toBe(emHoras(12).getTime());
    // Preço e duração vêm da consulta antiga, não da tabela.
    expect(r.consulta.price_cents).toBe(original.consulta.price_cents);
  });

  it('remarcar para horário ocupado deixa a consulta original intacta', async () => {
    const minha = await withClinic(
      c.clinicA,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: c.profA,
          pacienteId: c.patients[0]!,
          procedimentoId: c.procEletivo,
          inicio: emHoras(20),
        }),
      db,
    );
    const doOutro = await withClinic(
      c.clinicA,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: c.profA,
          pacienteId: c.patients[1]!,
          procedimentoId: c.procEletivo,
          inicio: emHoras(22),
        }),
      db,
    );
    expect(minha.ok && doOutro.ok).toBe(true);
    if (!minha.ok || !doOutro.ok) return;

    const r = await withClinic(
      c.clinicA,
      (trx) => agenda.remarcar(trx, minha.consulta.id, emHoras(22)),
      db,
    );
    expect(r).toEqual({ ok: false, motivo: 'horario_ocupado' });

    // Numa transação nova: o rollback do savepoint sobreviveu ao commit.
    const depois = await withClinic(c.clinicA, (trx) => agenda.porId(trx, minha.consulta.id), db);
    expect(depois?.status).toBe('agendado');
    expect(depois?.starts_at.getTime()).toBe(emHoras(20).getTime());
    expect(depois?.cancelled_at).toBeNull();

    // E a consulta do outro paciente continua onde estava.
    const outro = await withClinic(c.clinicA, (trx) => agenda.porId(trx, doOutro.consulta.id), db);
    expect(outro?.status).toBe('agendado');
  });

  it('lista por período e ignora o que está fora dele', async () => {
    const dentro = await withClinic(
      c.clinicA,
      (trx) => agenda.listarPorPeriodo(trx, emHoras(0), emHoras(24)),
      db,
    );
    expect(dentro.length).toBeGreaterThan(0);
    for (const a of dentro) {
      expect(a.starts_at.getTime()).toBeGreaterThanOrEqual(emHoras(0).getTime());
      expect(a.starts_at.getTime()).toBeLessThan(emHoras(24).getTime());
    }
  });
});

describe('pacientes e consentimento', () => {
  it('cria quem chegou pelo WhatsApp como "a confirmar" e sem consentimento', async () => {
    const r = await withClinic(
      c.clinicA,
      (trx) => pacientes.acharOuCriarPorTelefone(trx, c.clinicA, '+5511977776666'),
      db,
    );

    expect(r.novo).toBe(true);
    expect(r.paciente.name).toBe(pacientes.NOME_A_CONFIRMAR);
    expect(r.paciente.whatsapp_consent_at).toBeNull();
  });

  it('acha o mesmo paciente na segunda mensagem', async () => {
    const r = await withClinic(
      c.clinicA,
      (trx) => pacientes.acharOuCriarPorTelefone(trx, c.clinicA, '+5511977776666'),
      db,
    );
    expect(r.novo).toBe(false);
  });

  it('registra o consentimento uma vez e não sobrescreve a data', async () => {
    const primeiro = new Date('2026-03-01T12:00:00Z');
    const segundo = new Date('2026-06-01T12:00:00Z');

    const p = await withClinic(
      c.clinicA,
      async (trx) => {
        const { paciente } = await pacientes.acharOuCriarPorTelefone(
          trx,
          c.clinicA,
          '+5511955554444',
        );
        await pacientes.registrarConsentimento(trx, paciente.id, primeiro);
        await pacientes.registrarConsentimento(trx, paciente.id, segundo);
        return pacientes.porId(trx, paciente.id);
      },
      db,
    );

    expect(p?.whatsapp_consent_at?.getTime()).toBe(primeiro.getTime());
  });
});

describe('conversas', () => {
  it('grava a mesma mensagem da Meta uma vez só', async () => {
    const wamid = 'wamid.TESTE123';

    const r = await withClinic(
      c.clinicA,
      async (trx) => {
        const conversa = await conversas.acharOuCriarPorPaciente(trx, c.clinicA, c.patients[3]!);
        const base = {
          conversaId: conversa.id,
          clinicId: c.clinicA,
          direcao: 'entrada' as const,
          autor: 'paciente' as const,
          wamid,
          corpo: 'oi, queria marcar',
        };
        const primeira = await conversas.registrar(trx, base);
        const repetida = await conversas.registrar(trx, base);
        const todas = await conversas.ultimasMensagens(trx, conversa.id);
        return { primeira, repetida, todas };
      },
      db,
    );

    expect(r.primeira.novo).toBe(true);
    expect(r.repetida.novo).toBe(false);
    expect(r.repetida.mensagem.id).toBe(r.primeira.mensagem.id);
    expect(r.todas).toHaveLength(1);
  });

  it('assume e devolve a conversa', async () => {
    const r = await withClinic(
      c.clinicA,
      async (trx) => {
        const conversa = await conversas.acharOuCriarPorPaciente(trx, c.clinicA, c.patients[3]!);
        const assumida = await conversas.definirModo(trx, conversa.id, 'humano', 'pediu atendente');
        const devolvida = await conversas.definirModo(trx, conversa.id, 'ia');
        return { assumida, devolvida };
      },
      db,
    );

    expect(r.assumida?.mode).toBe('humano');
    expect(r.assumida?.handover_reason).toBe('pediu atendente');
    expect(r.devolvida?.mode).toBe('ia');
    expect(r.devolvida?.handover_reason).toBeNull();
  });
});

describe('fila de espera', () => {
  it('a vaga é de quem aceita primeiro; os outros continuam na fila', async () => {
    const inicio = emHoras(50);
    const fim = new Date(inicio.getTime() + 60 * 60_000);
    const dia = inicio.toISOString().slice(0, 10);

    const r = await withClinic(
      c.clinicA,
      async (trx) => {
        const um = await fila.entrar(trx, c.clinicA, {
          pacienteId: c.patients[0]!,
          procedimentoId: c.procEletivo,
          janelaInicio: new Date(dia),
          janelaFim: new Date(dia),
        });
        const dois = await fila.entrar(trx, c.clinicA, {
          pacienteId: c.patients[1]!,
          procedimentoId: c.procEletivo,
          janelaInicio: new Date(dia),
          janelaFim: new Date(dia),
        });

        const expira = new Date(Date.now() + 20 * 60_000);
        const ofertaUm = await fila.criarOferta(
          trx,
          c.clinicA,
          um.id,
          c.profA,
          inicio,
          fim,
          expira,
        );
        const ofertaDois = await fila.criarOferta(
          trx,
          c.clinicA,
          dois.id,
          c.profA,
          inicio,
          fim,
          expira,
        );

        const primeiro = await fila.aceitarOferta(trx, ofertaUm.id);
        const segundo = await fila.aceitarOferta(trx, ofertaDois.id);
        const entradaDois = await trx
          .selectFrom('app.waitlist_entries')
          .selectAll()
          .where('id', '=', dois.id)
          .executeTakeFirstOrThrow();
        return { primeiro, segundo, entradaDois };
      },
      db,
    );

    expect(r.primeiro.ok).toBe(true);
    expect(r.segundo).toEqual({ ok: false, motivo: 'preenchida_por_outro' });
    // Quem não levou a vaga continua aguardando — não foi removido da fila.
    expect(r.entradaDois.status).toBe('aguardando');
  });
});
