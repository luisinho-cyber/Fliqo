#!/usr/bin/env node
/**
 * Dá login e senha ao papel `fliqo_app`, o papel com que a API e o worker
 * conectam em produção.
 *
 * A migração 0001 cria o papel como `nologin` e dá as permissões. Falta o que
 * não pode morar em migração: a senha. Ela vem do ambiente, é gravada no
 * Postgres pelo `format(..., %L)` do próprio banco (que cuida das aspas) e nunca
 * aparece na saída deste script nem em nenhum arquivo do repositório.
 *
 * Rodar de novo com outra senha é como se troca a senha do papel.
 *
 * Uso:
 *   DATABASE_ADMIN_URL=... FLIQO_APP_PASSWORD=... node packages/db/scripts/papel-app.mjs
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { adminUrlDoAmbiente } from './pooler.mjs';
import { falhar } from './segredos.mjs';

export const PAPEL = 'fliqo_app';

/** Mínimo para uma senha de serviço. Curta demais não é descuido: é convite. */
const TAMANHO_MINIMO = 20;

export async function definirPapelDaAplicacao(adminUrl, senha) {
  if (typeof senha !== 'string' || senha.length < TAMANHO_MINIMO) {
    throw new Error(`a senha de ${PAPEL} precisa ter ao menos ${TAMANHO_MINIMO} caracteres`);
  }

  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const existia = await c.query('select 1 from pg_roles where rolname = $1', [PAPEL]);
    if (existia.rowCount === 0) {
      // Sem a migração aplicada o papel não teria permissão nenhuma; criar aqui
      // serve só para a ordem dos passos não importar.
      await c.query(`create role ${PAPEL} nologin`);
    }

    // Os atributos vão junto com a senha, sempre: o papel da aplicação existe
    // para passar pela RLS. Um `bypassrls` colado à mão em algum momento faria
    // toda a separação entre clínicas virar enfeite, sem erro nenhum aparecer.
    // %L é o escape de literal do próprio Postgres: a senha nunca é concatenada
    // por nós em uma string de SQL.
    const { rows } = await c.query(
      `select format(
         'alter role ${PAPEL} with login nosuperuser nobypassrls nocreatedb nocreaterole password %L',
         $1::text
       ) as comando`,
      [senha],
    );
    await c.query(rows[0].comando);

    return { criado: existia.rowCount === 0 };
  } finally {
    await c.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const senha = process.env.FLIQO_APP_PASSWORD;
  if (!senha) {
    console.error(
      'FLIQO_APP_PASSWORD não definida. Gere uma no gerenciador de senhas (30 caracteres) e\n' +
        'cadastre como secret do repositório — veja docs/DEPLOY.md, passo 2.',
    );
    process.exit(1);
  }
  const url = await adminUrlDoAmbiente();
  try {
    const { criado } = await definirPapelDaAplicacao(url, senha);
    console.log(
      criado ? `papel ${PAPEL} criado e com senha definida` : `senha do papel ${PAPEL} definida`,
    );
  } catch (erro) {
    falhar(erro, [url, senha]);
  }
}
