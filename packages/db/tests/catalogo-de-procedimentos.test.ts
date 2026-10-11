import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criarDb, procedimentos, withClinic, type Db } from '../src/index';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from './helpers';

/**
 * O catálogo inicial e o check do retorno, conferidos no banco.
 *
 * As duas metades que a rota não cobre: o check `procedures_followup_check` (0014) é o que
 * garante o par consistente mesmo para quem escreve direto no banco — a união discriminada
 * do TypeScript protege só quem passa pelo nosso código —, e a semeadura é o que a clínica
 * nova recebe antes de a primeira pessoa olhar a tela.
 */

let owner: pg.Pool;
let db: Db;
let c: Scenario;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  // Pelo caminho da aplicação, de propósito: a semeadura roda dentro de `withClinic`, e é a
  // RLS que decide em qual clínica o catálogo entra.
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await owner.end();
  await db.destroy();
});

async function inserirCru(nome: string, pedeRetorno: boolean, dias: number | null): Promise<void> {
  await owner.query(
    `insert into app.procedures (clinic_id, name, duration_minutes, price_cents,
                                 requires_followup, followup_days)
     values ($1, $2, 30, 1000, $3, $4)`,
    [c.clinicA, nome, pedeRetorno, dias],
  );
}

describe('o check do retorno vale até para quem escreve direto no banco', () => {
  it('pede retorno e diz o prazo: aceita', async () => {
    await expect(inserirCru('ok com prazo', true, 15)).resolves.toBeUndefined();
  });

  it('não pede retorno e o prazo é nulo: aceita', async () => {
    await expect(inserirCru('ok sem prazo', false, null)).resolves.toBeUndefined();
  });

  it('pede retorno sem prazo: o banco recusa', async () => {
    // Sem o check, a tela teria de decidir o que mostrar para "pede retorno em (nada)".
    await expect(inserirCru('pede sem prazo', true, null)).rejects.toThrow(
      /procedures_followup_check/,
    );
  });

  it('prazo sem pedir retorno: o banco recusa', async () => {
    // São dois jeitos de dizer a mesma coisa, e é assim que um relatório conta metade.
    await expect(inserirCru('prazo sem pedir', false, 30)).rejects.toThrow(
      /procedures_followup_check/,
    );
  });

  it('prazo zero e prazo de mais de um ano: o banco recusa', async () => {
    await expect(inserirCru('prazo zero', true, 0)).rejects.toThrow(/procedures_followup_check/);
    await expect(inserirCru('prazo longo', true, 366)).rejects.toThrow(/procedures_followup_check/);
  });

  it('o default deixa toda linha antiga válida: insert sem as colunas novas passa', async () => {
    // É o que torna a 0014 aditiva de verdade: nenhuma linha existente vira inválida.
    await expect(
      owner.query(
        `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
         values ($1, 'sem mencionar retorno', 30, 1000)`,
        [c.clinicA],
      ),
    ).resolves.toBeDefined();
  });
});

describe('o catálogo inicial', () => {
  const catalogo = procedimentos.lerCatalogoInicial();

  it('tem oito de odontologia e seis de estética', () => {
    expect(catalogo.odontologia).toHaveLength(8);
    expect(catalogo.estetica).toHaveLength(6);
  });

  it('todo preço é inteiro em centavos, e nenhum é float', () => {
    for (const p of [...catalogo.odontologia, ...catalogo.estetica]) {
      expect(Number.isInteger(p.precoCents), p.nome).toBe(true);
      expect(p.precoCents, p.nome).toBeGreaterThan(0);
    }
  });

  it('toda duração e todo prazo cabem nos checks do banco', () => {
    // O catálogo é dado nosso, e dado nosso que o banco recusa é o pior tipo de seed: ele
    // falha na criação da clínica, que é o primeiro minuto de uso.
    for (const p of [...catalogo.odontologia, ...catalogo.estetica]) {
      expect(p.duracaoMinutos, p.nome).toBeGreaterThanOrEqual(5);
      expect(p.duracaoMinutos, p.nome).toBeLessThanOrEqual(600);
      if (p.retorno.exige) {
        expect(p.retorno.emDias, p.nome).toBeGreaterThanOrEqual(1);
        expect(p.retorno.emDias, p.nome).toBeLessThanOrEqual(365);
      }
    }
  });

  it('nenhum nome repete, nem ignorando maiúscula', () => {
    // O índice da 0013 é `lower(name)`: dois nomes que só diferem na caixa fariam a
    // semeadura pular um deles em silêncio.
    const nomes = [...catalogo.odontologia, ...catalogo.estetica].map((p) => p.nome.toLowerCase());
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('semeia os catorze numa clínica, dentro do withClinic', async () => {
    const r = await withClinic(
      c.clinicA,
      async (trx) =>
        procedimentos.semear(trx, c.clinicA, [...catalogo.odontologia, ...catalogo.estetica]),
      db,
    );
    expect(r.criados).toHaveLength(14);
    expect(r.pulados).toEqual([]);

    const lista = await withClinic(c.clinicA, (trx) => procedimentos.listarTodos(trx), db);
    expect(lista.filter((p) => p.name === 'Implante unitário')).toHaveLength(1);
  });

  it('semear de novo não duplica nada e não estoura', async () => {
    // Criação de clínica é o tipo de fluxo que alguém repete depois de um erro de rede.
    const r = await withClinic(
      c.clinicA,
      async (trx) =>
        procedimentos.semear(trx, c.clinicA, [...catalogo.odontologia, ...catalogo.estetica]),
      db,
    );
    expect(r.criados).toEqual([]);
    expect(r.pulados).toHaveLength(14);
  });

  it('o retorno do catálogo chega ao banco', async () => {
    const lista = await withClinic(c.clinicA, (trx) => procedimentos.listarTodos(trx), db);
    const limpeza = lista.find((p) => p.name === 'Limpeza e profilaxia');
    expect(limpeza).toBeDefined();
    expect(procedimentos.retornoDe(limpeza!)).toEqual({ exige: true, emDias: 180 });

    const avaliacao = lista.find((p) => p.name === 'Consulta de avaliação');
    expect(avaliacao).toBeDefined();
    expect(procedimentos.retornoDe(avaliacao!)).toEqual({ exige: false });
  });

  it('a clínica B não recebe o catálogo da A', async () => {
    const daB = await withClinic(c.clinicB, (trx) => procedimentos.listarTodos(trx), db);
    expect(daB.map((p) => p.name)).not.toContain('Implante unitário');
  });
});
