import { criarDb, type Db } from '@fliqo/db';
import { ia } from '@fliqo/db';
import { ownerPool, resetDatabase, urlDoTester } from '@fliqo/db/testing';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINICA_DEMO, semearDemo } from '../src/semear-demo';

/**
 * Semear é um fluxo que se repete — banco recriado, erro de rede, deploy de novo.
 * Rodar duas vezes não pode duplicar clínica nem versão de perfil.
 */

let owner: pg.Pool;
let db: Db;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

async function contar(tabela: 'clinics' | 'ai_profiles'): Promise<number> {
  const { rows } = await owner.query<{ quantas: string }>(
    `select count(*) as quantas from app.${tabela}`,
  );
  return Number(rows[0]?.quantas);
}

describe('semeadura da clínica de demonstração', () => {
  it('a primeira rodada cria a clínica e o perfil ativo; a segunda não duplica', async () => {
    const primeira = await semearDemo(db, ia.lerPerfilDemo());
    expect(primeira).toMatchObject({
      clinicaId: CLINICA_DEMO,
      clinica: 'criada',
      perfil: { acao: 'criado', versao: 1 },
    });

    const segunda = await semearDemo(db, ia.lerPerfilDemo());
    expect(segunda).toMatchObject({
      clinica: 'existente',
      perfil: { acao: 'mantido', versao: 1 },
    });

    expect(await contar('clinics')).toBe(1);
    expect(await contar('ai_profiles')).toBe(1);
  });

  it('a clínica semeada é de demonstração e carrega o nome do arquivo', async () => {
    const { rows } = await owner.query<{ name: string; is_demo: boolean }>(
      'select name, is_demo from app.clinics where id = $1',
      [CLINICA_DEMO],
    );
    expect(rows[0]?.is_demo).toBe(true);
    expect(rows[0]?.name).toBe('Clínica Demo Sorriso & Harmonia');
  });

  it('o perfil gravado é o que o worker lê de volta, com os defaults preenchidos', async () => {
    const { rows } = await owner.query<{ profile: { ritmo?: unknown; fila?: unknown } }>(
      'select profile from app.ai_profiles where clinic_id = $1 and is_active',
      [CLINICA_DEMO],
    );
    // O arquivo não traz `ritmo` nem `fila`: vêm do Zod, e é por isso que a segunda
    // rodada compara igual em vez de abrir uma versão nova toda vez.
    expect(rows[0]?.profile.ritmo).toBeDefined();
    expect(rows[0]?.profile.fila).toEqual({ maxOfertasPorDia: 3 });
  });

  it('perfil diferente abre a versão seguinte e só um fica ativo', async () => {
    const perfil = ia.lerPerfilDemo() as { persona: { nome: string } };
    perfil.persona.nome = 'Mariana';

    const r = await semearDemo(db, perfil);
    expect(r.perfil).toEqual({ acao: 'nova_versao', versao: 2 });

    const { rows } = await owner.query<{ version: number }>(
      'select version from app.ai_profiles where clinic_id = $1 and is_active',
      [CLINICA_DEMO],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    expect(await contar('ai_profiles')).toBe(2);
  });

  it('perfil incompleto é recusado antes de encostar no banco', async () => {
    const antes = await contar('ai_profiles');
    await expect(semearDemo(db, { clinica: { nome: 'Sem o resto' } })).rejects.toThrow();
    expect(await contar('ai_profiles')).toBe(antes);
  });
});
