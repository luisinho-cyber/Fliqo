import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  comandosDaPolitica,
  referenciasNaoConferidas,
  comandosNecessarios,
  conferir,
  referenciasSemEsquema,
  relatorio,
  tabelasReferenciadas,
  veredito,
  type CasoDeConferencia,
} from '../scripts/rls-definer.mjs';
import { adminUrlDoAmbiente } from '../scripts/pooler.mjs';
import { ownerPool, resetDatabase } from '../src/testing';

/**
 * A conferência de acesso das funções `security definer`.
 *
 * Uma função dessas roda com os poderes do DONO dela. Se a tabela que ela lê tem
 * `force row level security`, a política passa a valer também para o dono — e a
 * função, que existe para cruzar clínicas antes de haver clínica na transação,
 * devolve zero linha. Nada estoura: a operação só para de acontecer.
 *
 * Aqui o `postgres` é superusuário e ignora RLS, então o cenário de produção é
 * montado à mão: um papel dono SEM superusuário e SEM bypassrls.
 */

const TABELAS = ['appointments', 'clinics', 'scheduled_actions', 'whatsapp_numbers'];

describe('tabelasReferenciadas', () => {
  it('acha as tabelas citadas como app.<tabela>', () => {
    const corpo = `select distinct a.clinic_id from app.appointments a
                     join app.clinics c on c.id = a.clinic_id`;
    expect(tabelasReferenciadas(corpo, TABELAS)).toEqual(['appointments', 'clinics']);
  });

  it('não confunde nome parecido nem conta duas vezes', () => {
    const corpo = `select 1 from app.clinics, app.clinics c2, app.clinic_ids_of_member(x)`;
    expect(tabelasReferenciadas(corpo, TABELAS)).toEqual(['clinics']);
  });

  it('ignora o que não é tabela conhecida', () => {
    expect(tabelasReferenciadas('select app.clinic_id()', TABELAS)).toEqual([]);
  });
});

describe('referenciasSemEsquema', () => {
  it('acusa tabela citada sem o prefixo app.', () => {
    // Guarda do próprio parser: sem isto, uma função que confia no search_path
    // passaria batida e a conferência diria "nada a checar".
    expect(referenciasSemEsquema('select 1 from appointments', TABELAS)).toEqual(['appointments']);
  });

  it('não acusa quando a referência está qualificada', () => {
    expect(referenciasSemEsquema('select 1 from app.appointments', TABELAS)).toEqual([]);
  });

  it('não confunde nome de coluna com nome de tabela qualificada', () => {
    expect(referenciasSemEsquema('select a.clinic_id from app.clinics a', TABELAS)).toEqual([]);
  });
});

describe('referenciasNaoConferidas', () => {
  const FUNCOES = ['clinic_id', 'rank_waitlist'];

  it('tabela e função conhecidas não são acusadas', () => {
    const corpo = 'select 1 from app.clinics where id = app.clinic_id()';
    expect(referenciasNaoConferidas(corpo, TABELAS, FUNCOES)).toEqual([]);
  });

  it('acusa view e tabela que sumiu, em vez de pular em silêncio', () => {
    // Pular em silêncio é o falso verde que a conferência existe para impedir.
    const corpo = 'select * from app.procedure_real_durations join app.tabela_que_sumiu on true';
    expect(referenciasNaoConferidas(corpo, TABELAS, FUNCOES)).toEqual([
      'procedure_real_durations',
      'tabela_que_sumiu',
    ]);
  });
});

describe('comandosNecessarios', () => {
  it('ler é sempre necessário', () => {
    expect(comandosNecessarios('select 1 from app.clinics', 'clinics')).toEqual(['select']);
  });

  it('função que faz UPDATE precisa de escrita, não só de leitura', () => {
    // É a diferença entre a fila de ações rodar e travar em silêncio.
    const corpo = `update app.scheduled_actions set status = 'executando'
                    where id in (select id from app.scheduled_actions) returning *`;
    expect(comandosNecessarios(corpo, 'scheduled_actions')).toEqual(['select', 'update']);
  });

  it('não confunde escrita em outra tabela com escrita nesta', () => {
    const corpo = `update app.appointments set status = 'x' from app.clinics c`;
    expect(comandosNecessarios(corpo, 'clinics')).toEqual(['select']);
    expect(comandosNecessarios(corpo, 'appointments')).toEqual(['select', 'update']);
  });
});

describe('comandosDaPolitica', () => {
  it('traduz a letra de polcmd', () => {
    expect(comandosDaPolitica('r')).toEqual(['select']);
    expect(comandosDaPolitica('w')).toEqual(['update']);
    expect(comandosDaPolitica('*')).toEqual(['select', 'insert', 'update', 'delete']);
  });
});

const BASE: CasoDeConferencia = {
  funcao: 'f',
  tabela: 'appointments',
  dono: 'dono',
  rlsForcada: true,
  donoEhSuperusuario: false,
  donoTemBypassRls: false,
  rlsAtivaParaODono: true,
  politicasQueNomeiamODono: [],
  comandosNecessarios: ['select'],
};

describe('veredito', () => {
  it('superusuário passa', () => {
    expect(veredito({ ...BASE, donoEhSuperusuario: true }).ok).toBe(true);
  });

  it('bypassrls passa', () => {
    expect(veredito({ ...BASE, donoTemBypassRls: true }).ok).toBe(true);
  });

  it('a palavra do Postgres vale mais que a dedução', () => {
    expect(veredito({ ...BASE, rlsAtivaParaODono: false }).ok).toBe(true);
  });

  it('política que nomeia o papel e cobre o comando passa, e diz qual', () => {
    const v = veredito({
      ...BASE,
      politicasQueNomeiamODono: [{ nome: 'dono_do_schema_le', comandos: ['select'] }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.porque).toContain('dono_do_schema_le');
  });

  it('política for select onde a função ESCREVE não passa', () => {
    // O ponto: uma política de leitura aqui silenciaria a acusação e deixaria a
    // fila travada em produção. Política que cobre menos do que a função faz é
    // pior do que política nenhuma.
    const v = veredito({
      ...BASE,
      tabela: 'scheduled_actions',
      comandosNecessarios: ['select', 'update'],
      politicasQueNomeiamODono: [{ nome: 'so_leitura', comandos: ['select'] }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.mensagem).toContain('não cobre update');
      expect(v.mensagem).toContain('for all');
    }
  });

  it('política for all cobre leitura e escrita', () => {
    const v = veredito({
      ...BASE,
      tabela: 'scheduled_actions',
      comandosNecessarios: ['select', 'update'],
      politicasQueNomeiamODono: [
        { nome: 'dono_faz_tudo', comandos: ['select', 'insert', 'update', 'delete'] },
      ],
    });
    expect(v.ok).toBe(true);
  });

  it('sem política, a mensagem pede for all quando há escrita', () => {
    const v = veredito({
      ...BASE,
      tabela: 'scheduled_actions',
      comandosNecessarios: ['select', 'update'],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.mensagem).toContain('for all');
  });

  it('sem nada disso, falha nomeando função, tabela e papel', () => {
    const v = veredito(BASE);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.mensagem).toContain('f()');
      expect(v.mensagem).toContain('app.appointments');
      expect(v.mensagem).toContain('dono');
      // A correção preferida é política explícita, não BYPASSRLS.
      expect(v.mensagem).toContain('política explícita');
      expect(v.mensagem).not.toContain('BYPASSRLS liberando');
    }
  });

  it('não deu para assumir o papel: falha em vez de chutar que está tudo bem', () => {
    const v = veredito({ ...BASE, rlsAtivaParaODono: undefined, rlsForcada: false });
    expect(v.ok).toBe(false);
  });
});

describe('a saída não conta nada além do que precisa', () => {
  const URL_COM_SENHA =
    'postgresql://postgres:Senha-Secreta-123@db.projeto.supabase.co:5432/postgres';

  it('o relatório traz papel, função, tabela e veredito — e nada de conexão', () => {
    const texto = relatorio({
      usuarioAtual: 'postgres',
      linhas: [
        {
          ...BASE,
          ok: false,
          mensagem: 'presa',
          comandosNecessarios: ['select'],
          politicasQueNomeiamODono: [],
        },
      ],
      falhas: ['presa'],
      naoQualificadas: [],
      naoConferidas: [],
    });

    expect(texto).toContain('f()');
    expect(texto).toContain('app.appointments');
    expect(texto).toContain('dono');
    expect(texto).toContain('super');
    expect(texto).toContain('bypassrls');

    // Nada de host, porta, usuário de conexão ou string inteira.
    expect(texto).not.toContain('postgresql://');
    expect(texto).not.toContain('@');
    expect(texto).not.toContain('supabase.co');
    expect(texto).not.toContain('5432');
  });

  it('o silencioso não imprime nem o diagnóstico de conexão', async () => {
    // A migração continua com o diagnóstico (host, porta, usuário). Esta
    // conferência não pode nem isso.
    const espiao = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const capturado: string[] = [];
      await adminUrlDoAmbiente(
        { DATABASE_ADMIN_URL: URL_COM_SENHA.replace('db.projeto.supabase.co', 'localhost') },
        { registrar: (linha) => capturado.push(linha) },
      );
      expect(capturado).toHaveLength(1);
      expect(capturado[0]).toContain('host=localhost');
      // Mesmo o diagnóstico da migração nunca carrega a senha.
      expect(capturado[0]).not.toContain('Senha-Secreta-123');

      capturado.length = 0;
      await adminUrlDoAmbiente(
        { DATABASE_ADMIN_URL: URL_COM_SENHA.replace('db.projeto.supabase.co', 'localhost') },
        { registrar: () => undefined },
      );
      expect(capturado).toHaveLength(0);
      expect(espiao).not.toHaveBeenCalled();
    } finally {
      espiao.mockRestore();
    }
  });
});

/**
 * O comando como o workflow o roda.
 *
 * Os testes acima cobrem as funções; este cobre o bloco do CLI, que é onde mora
 * a decisão de silenciar o diagnóstico de conexão. Sem ele, alguém tira o
 * `registrar` silencioso e nada acusa.
 */
describe('o comando db:conferir-rls', () => {
  const rodar = promisify(execFile);

  /** A conexão de dono apontando para o banco descartável. */
  function urlDoDono(): string {
    const u = new URL(
      process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres@localhost:5432/postgres',
    );
    u.pathname = '/fliqo_test';
    return u.toString();
  }

  beforeAll(async () => {
    await resetDatabase();
  }, 90_000);

  it('não imprime string de conexão, host, porta nem usuário de conexão', async () => {
    const { stdout, stderr } = await rodar('node', ['packages/db/scripts/rls-definer.mjs'], {
      env: { ...process.env, DATABASE_ADMIN_URL: urlDoDono() },
    });
    const tudo = stdout + stderr;

    // O que PODE aparecer: papel, função, tabela, veredito.
    expect(tudo).toContain('claim_due_actions()');
    expect(tudo).toContain('app.scheduled_actions');
    expect(tudo).toContain('bypassrls');

    // O que NÃO pode, em hipótese alguma.
    expect(tudo).not.toContain('postgresql://');
    expect(tudo).not.toContain('@');
    expect(tudo).not.toContain('host=');
    expect(tudo).not.toContain('porta=');
    expect(tudo).not.toContain(':5432');
  });
});

/**
 * A conferência contra um banco de verdade, com dono como o do Supabase: sem
 * superusuário e sem bypassrls.
 */
describe('conferência contra o banco, com dono sem superusuário', () => {
  const DONO = 'dono_sem_super';
  const SENHA = 'senha-de-teste-do-dono';
  let owner: pg.Pool;
  let comoDono: pg.Client | undefined;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();

    await owner.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${DONO}') then
        create role ${DONO} login password '${SENHA}';
      else
        alter role ${DONO} login password '${SENHA}';
      end if; end $$`);
    // O papel do Supabase: dono do schema, mas nem superusuário nem bypassrls.
    await owner.query(`alter role ${DONO} nosuperuser nobypassrls`);
    await owner.query(`grant ${DONO} to current_user`);
    await owner.query(`alter schema app owner to ${DONO}`);
    for (const consulta of [
      `select 'alter table app.' || quote_ident(relname) || ' owner to ${DONO}' as cmd
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r'`,
      `select 'alter function app.' || quote_ident(proname) || '(' ||
              pg_get_function_identity_arguments(p.oid) || ') owner to ${DONO}' as cmd
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'`,
    ]) {
      const { rows } = await owner.query<{ cmd: string }>(consulta);
      for (const r of rows) await owner.query(r.cmd);
    }

    const url = new URL('postgresql://localhost:5432/fliqo_test');
    url.username = DONO;
    url.password = SENHA;
    comoDono = new pg.Client({ connectionString: url.toString() });
    await comoDono.connect();
  }, 90_000);

  afterAll(async () => {
    // Guardado: se o beforeAll morreu antes de conectar, o afterAll não pode
    // esconder o erro de verdade atrás de um "undefined.end()".
    await comoDono?.end();
    // O banco de teste é recriado por arquivo, mas o papel é do cluster.
    await owner.query(`alter schema app owner to current_user`).catch(() => undefined);
    await owner.end();
  });

  it('acusa a função que lê tabela com force e não é alcançada por política', async () => {
    const r = await conferir(comoDono!);
    const acusadas = r.linhas.filter((l) => !l.ok).map((l) => `${l.funcao}:${l.tabela}`);
    // A varredura de atrasos e a fila de ações são as que doem: elas param de
    // acontecer sem erro nenhum aparecer.
    expect(acusadas).toContain('clinics_with_appointments_today:appointments');
    expect(acusadas).toContain('claim_due_actions:scheduled_actions');
    expect(r.falhas.length).toBeGreaterThan(0);
  });

  it('não acusa a tabela que de propósito não força RLS', async () => {
    // A 0003 deixou whatsapp_numbers sem force exatamente para o webhook
    // funcionar. É o único par que sobrevive a um dono sem bypassrls.
    const r = await conferir(comoDono!);
    const webhook = r.linhas.find((l) => l.funcao === 'clinic_by_phone_number_id');
    expect(webhook?.ok).toBe(true);
  });

  it('política explícita nomeando o papel dono resolve — e é a correção preferida', async () => {
    // Prova que o conserto indicado na mensagem funciona, antes de aplicá-lo:
    // política visível no schema e com escopo por tabela, não BYPASSRLS global.
    await owner.query(
      `create policy dono_do_schema_le on app.appointments for select to ${DONO} using (true)`,
    );
    try {
      const r = await conferir(comoDono!);
      const ainda = r.linhas.filter(
        (l) =>
          !l.ok && l.funcao === 'clinics_with_appointments_today' && l.tabela === 'appointments',
      );
      expect(ainda).toEqual([]);
    } finally {
      await owner.query(`drop policy dono_do_schema_le on app.appointments`);
    }
  });

  it('nenhuma referência das cinco funções fica sem conferir', async () => {
    // Se uma função passar a ler uma view, ou uma tabela sumir, isto acusa em
    // vez de a conferência dizer "ok" sobre o que nem olhou.
    const r = await conferir(comoDono!);
    expect(r.naoConferidas).toEqual([]);
    expect(r.naoQualificadas).toEqual([]);
  });

  it('o relatório nomeia função, tabela e papel', async () => {
    const r = await conferir(comoDono!);
    const texto = relatorio(r);
    expect(texto).toContain('clinics_with_appointments_today');
    expect(texto).toContain('app.appointments');
    expect(texto).toContain(DONO);
  });
});
