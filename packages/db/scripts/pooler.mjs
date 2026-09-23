/**
 * Descobre sozinho por onde conectar no Supabase.
 *
 * A string de conexão do Supabase vem em três formas (Direct, Transaction
 * pooler, Session pooler), e o host do pooler muda de projeto para projeto
 * (`aws-0-...` ou `aws-1-...`, conforme o lote em que o projeto foi criado).
 * Exigir a forma exata no secret é convite a um erro que só aparece na hora da
 * migração, com uma mensagem que não ajuda ("Tenant or user not found").
 *
 * Aqui a gente aceita qualquer uma das três, pega o ref do projeto e monta a do
 * Session pooler — que é a que a migração precisa: IPv4 (as máquinas do GitHub
 * Actions não falam IPv6) e modo sessão (o migrador usa uma trava de sessão).
 */

import { falhar } from './segredos.mjs';

export const REGIAO_PADRAO = 'sa-east-1';
export const PORTA_SESSAO = 5432;

const HOST_SUPABASE = /\.supabase\.(co|com)$/i;
const HOST_DIRETO = /^db\.([a-z0-9]+)\.supabase\.(co|com)$/i;
const HOST_POOLER = /\.pooler\.supabase\.com$/i;
const USUARIO_COM_REF = /^postgres\.([a-z0-9]+)$/i;

/** Banco local (docker-compose, CI) não tem pooler nenhum para descobrir. */
export function ehDoSupabase(url) {
  return HOST_SUPABASE.test(paraUrl(url).hostname);
}

/**
 * O ref do projeto, venha ele do host (`db.<ref>.supabase.co`) ou do usuário
 * (`postgres.<ref>`, como o pooler exige).
 */
export function refDoProjeto(url) {
  const u = paraUrl(url);
  const doHost = HOST_DIRETO.exec(u.hostname);
  if (doHost) return doHost[1];
  const doUsuario = USUARIO_COM_REF.exec(decodeURIComponent(u.username));
  if (doUsuario) return doUsuario[1];
  return undefined;
}

/**
 * Hosts a tentar, em ordem. O host que veio na string entra primeiro quando já
 * é de pooler: se a pessoa colou a string certa, não faz sentido adivinhar.
 */
export function candidatosDeHost(url, regiao = REGIAO_PADRAO) {
  const daString = HOST_POOLER.test(paraUrl(url).hostname) ? [paraUrl(url).hostname] : [];
  return [
    ...new Set([
      ...daString,
      `aws-0-${regiao}.pooler.supabase.com`,
      `aws-1-${regiao}.pooler.supabase.com`,
    ]),
  ];
}

/** A string do Session pooler, montada a partir das partes. */
export function urlDoSessionPooler({ ref, senha, host }) {
  const usuario = encodeURIComponent(`postgres.${ref}`);
  return `postgresql://${usuario}:${encodeURIComponent(senha)}@${host}:${PORTA_SESSAO}/postgres`;
}

/** A senha, já decodificada. `%` solto na senha não é escape: fica como está. */
export function senhaDaUrl(url) {
  const bruta = paraUrl(url).password;
  try {
    return decodeURIComponent(bruta);
  } catch {
    return bruta;
  }
}

/**
 * Erro de host errado (adianta tentar o próximo) x erro de credencial (não
 * adianta: tentar os outros hosts só esconderia a senha errada atrás de uma
 * mensagem pior).
 */
export function ehHostErrado(erro) {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  const codigo = erro?.code;
  // "Tenant or user not found" é o jeito do Supavisor dizer "host errado".
  // "timeout expired" vem do pg quando o host existe no DNS mas não responde.
  if (/Tenant or user not found|timeout expired/i.test(mensagem)) return true;
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(codigo);
}

/**
 * Devolve a conexão de migração já resolvida, com o host que respondeu.
 * `testar` é injetável para o teste não abrir conexão de verdade.
 */
export async function resolverAdminUrl(bruta, opcoes = {}) {
  const regiao = opcoes.regiao || REGIAO_PADRAO;
  const testar = opcoes.testar ?? testarComPg;

  // Banco local passa direto: não há host de pooler para adivinhar, e falhar
  // aqui quebraria o desenvolvimento e o CI.
  if (!ehDoSupabase(bruta)) return { url: bruta, host: paraUrl(bruta).hostname, resolvido: false };

  const ref = refDoProjeto(bruta);
  if (ref === undefined) {
    throw new Error(
      'não deu para achar o ref do projeto na string de conexão. ' +
        'Copie uma das opções de Connect no Supabase (Direct, Session pooler ou Transaction pooler).',
    );
  }

  const senha = senhaDaUrl(bruta);
  if (senha === '') throw new Error('a string de conexão está sem senha');

  const tentados = [];
  for (const host of candidatosDeHost(bruta, regiao)) {
    const url = urlDoSessionPooler({ ref, senha, host });
    try {
      await testar(url);
      return { url, host, resolvido: true };
    } catch (erro) {
      if (!ehHostErrado(erro)) throw erro;
      tentados.push(host);
    }
  }
  // Só os hosts entram na mensagem: eles não são segredo, e são o que a pessoa
  // precisa ver para entender o que foi tentado.
  throw new Error(`nenhum host do pooler respondeu. Tentados: ${tentados.join(', ')}`);
}

async function testarComPg(url) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    await c.query('select 1');
  } finally {
    await c.end();
  }
}

function paraUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new Error('a string de conexão não é uma URL válida');
  }
}

/**
 * O que os scripts de linha de comando usam: lê DATABASE_ADMIN_URL, resolve o
 * host e conta qual foi. Só o host vai para a saída — a URL inteira carrega
 * usuário e senha.
 */
export async function adminUrlDoAmbiente(env = process.env) {
  const bruta = env.DATABASE_ADMIN_URL;
  if (!bruta) {
    console.error(
      'DATABASE_ADMIN_URL não definida. Localmente, suba o banco com `docker compose up -d` e exporte:\n' +
        '  export DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres',
    );
    process.exit(1);
  }
  try {
    const { url, host, resolvido } = await resolverAdminUrl(bruta, {
      ...(env.SUPABASE_REGION ? { regiao: env.SUPABASE_REGION } : {}),
    });
    if (resolvido) console.log(`conectando pelo pooler em ${host}`);
    return url;
  } catch (erro) {
    // Falhar aqui é falhar limpo: sem stack trace e sem a URL na saída.
    falhar(erro, [bruta, env.FLIQO_APP_PASSWORD]);
  }
}
