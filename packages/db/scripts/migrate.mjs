#!/usr/bin/env node
/**
 * Aplica packages/db/migrations/*.sql em ordem, uma vez cada.
 *
 * O registro fica em public.schema_migrations — fora do schema `app`, porque a migração
 * 0001 cria o `app` e o registro precisa existir antes disso.
 *
 * Duas garantias além de "não reaplicar":
 *  - cada migração roda junto com o próprio registro, na mesma transação: ou as duas
 *    coisas acontecem, ou nenhuma. Não existe migração aplicada e não registrada.
 *  - o checksum do arquivo é guardado. Se uma migração já aplicada for editada depois,
 *    o script para e manda criar 000N_*.sql (CLAUDE.md, regra 8: migrações são só de
 *    acréscimo). Sem isso, o banco de produção e o arquivo divergem em silêncio.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { falhar } from './segredos.mjs';

// Um número qualquer, fixo: o que importa é que todo migrador use o mesmo.
const LOCK_ID = 8472013;

const REGISTRO = `
  create table if not exists public.schema_migrations (
    version    text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
  )
`;

function migracoes() {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  return readdirSync(dir)
    .filter((nome) => nome.endsWith('.sql'))
    .sort()
    .map((nome) => {
      const sql = readFileSync(dir + nome, 'utf8');
      return { versao: nome, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

async function aplicar(client, m) {
  await client.query('begin');
  try {
    await client.query(m.sql);
    await client.query('insert into public.schema_migrations (version, checksum) values ($1, $2)', [
      m.versao,
      m.checksum,
    ]);
    await client.query('commit');
  } catch (erro) {
    await client.query('rollback');
    throw erro;
  }
}

export async function migrar(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const resumo = { aplicadas: [], puladas: [] };
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(REGISTRO);

    const { rows } = await client.query('select version, checksum from public.schema_migrations');
    const jaAplicadas = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of migracoes()) {
      const checksumAnterior = jaAplicadas.get(m.versao);

      if (checksumAnterior === undefined) {
        console.log(`aplicando ${m.versao}`);
        await aplicar(client, m);
        resumo.aplicadas.push(m.versao);
        continue;
      }

      if (checksumAnterior !== m.checksum) {
        throw new Error(
          `${m.versao} já foi aplicada neste banco e o arquivo mudou desde então.\n` +
            'Migração aplicada nunca é editada (CLAUDE.md, regra 8): crie uma nova 000N_*.sql ' +
            'com a alteração.',
        );
      }

      console.log(`${m.versao} já aplicada`);
      resumo.puladas.push(m.versao);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
  return resumo;
}

// Só executa quando chamado pela linha de comando; importado (pelo teste), só exporta.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error(
      'DATABASE_ADMIN_URL não definida. Suba o banco com `docker compose up -d` e exporte:\n' +
        '  export DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres',
    );
    process.exit(1);
  }
  try {
    const { aplicadas, puladas } = await migrar(url);
    console.log(
      aplicadas.length === 0
        ? `nada a fazer — ${puladas.length} migração(ões) já aplicada(s)`
        : `pronto — ${aplicadas.length} aplicada(s), ${puladas.length} já estava(m) no banco`,
    );
  } catch (erro) {
    falhar(erro, [url]);
  }
}
