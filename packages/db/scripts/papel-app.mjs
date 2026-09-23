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

/**
 * O único comando que troca a senha.
 *
 * Só LOGIN e a senha. Nada de NOSUPERUSER, NOBYPASSRLS ou NOREPLICATION: no
 * Postgres, definir ou negar esses três exige superusuário, e o `postgres` do
 * Supabase não é. Mandá-los derrubava o script inteiro com "permission denied to
 * alter role" — e eles não eram necessários: papel recém-criado já nasce sem os
 * três.
 *
 * %L é o escape de literal do próprio Postgres: a senha nunca é concatenada por
 * nós em uma string de SQL.
 */
export const SQL_COMANDO_DE_SENHA = `select format('alter role ${PAPEL} with login password %L', $1::text) as comando`;

/**
 * O que não dá para corrigir sem superusuário, dá para conferir.
 *
 * O papel da aplicação existe para passar pela RLS. Se ele ganhar `bypassrls` ou
 * `superuser` por algum caminho, a separação entre clínicas vira enfeite sem
 * nenhum erro aparecer. Como o script não pode mais negar esses atributos, ele
 * lê e para — fingir que está tudo bem seria pior do que falhar.
 */
export async function conferirAtributos(c) {
  const { rows } = await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = $1', [
    PAPEL,
  ]);
  const papel = rows[0];
  if (!papel) throw new Error(`o papel ${PAPEL} não existe depois de criado`);

  const problemas = [];
  if (papel.rolsuper) problemas.push('superuser');
  if (papel.rolbypassrls) problemas.push('bypassrls');
  if (problemas.length > 0) {
    throw new Error(
      `o papel ${PAPEL} está com ${problemas.join(' e ')}, e assim ele não passa pela RLS. ` +
        'Remover esses atributos exige superusuário, que este script não tem: peça ao suporte do ' +
        `Supabase para tirá-los de ${PAPEL}, ou recrie o papel do zero pelo SQL editor.`,
    );
  }
}

export async function definirPapelDaAplicacao(adminUrl, senha) {
  if (typeof senha !== 'string' || senha.length < TAMANHO_MINIMO) {
    throw new Error(`a senha de ${PAPEL} precisa ter ao menos ${TAMANHO_MINIMO} caracteres`);
  }

  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const existia = await c.query('select 1 from pg_roles where rolname = $1', [PAPEL]);
    if (existia.rowCount === 0) {
      // Papel novo nasce sem superuser, sem bypassrls e sem replication: são os
      // padrões do Postgres, e é por isso que não precisamos pedi-los.
      // Sem a migração aplicada ele não teria permissão nenhuma; criar aqui
      // serve só para a ordem dos passos não importar.
      await c.query(`create role ${PAPEL} nologin`);
    }

    const { rows } = await c.query(SQL_COMANDO_DE_SENHA, [senha]);
    await c.query(rows[0].comando);
    await conferirAtributos(c);

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
