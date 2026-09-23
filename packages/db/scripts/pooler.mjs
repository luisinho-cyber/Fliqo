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
 * A linha que vai para o log antes de cada tentativa de conexão.
 *
 * Host, porta e usuário não são segredo — o usuário do pooler carrega o ref do
 * projeto, que já aparece na URL do painel. A senha e a URL inteira nunca entram
 * aqui: é justamente por não ter esta linha que uma falha de senha parecia falha
 * de normalização.
 */
export function diagnostico(url, motivo) {
  const u = paraUrl(url);
  const porta = u.port === '' ? String(PORTA_SESSAO) : u.port;
  return `conexão: host=${u.hostname} porta=${porta} usuario=${decodeURIComponent(u.username)} — ${motivo}`;
}

/**
 * Host de pooler e usuário `postgres.<ref>` andam sempre juntos: o pooler roteia
 * pelo ref que vem no usuário. Um sem o outro é conexão que falha por motivo
 * obscuro, então falha aqui, com o motivo escrito.
 */
export function conferirAlvo(url) {
  const u = paraUrl(url);
  if (!HOST_POOLER.test(u.hostname)) {
    throw new Error(`alvo montado sem host de pooler: ${u.hostname}`);
  }
  if (!USUARIO_COM_REF.test(decodeURIComponent(u.username))) {
    throw new Error(`alvo montado sem o usuário postgres.<ref>: ${decodeURIComponent(u.username)}`);
  }
  if (u.port !== String(PORTA_SESSAO)) {
    throw new Error(`alvo montado fora da porta de sessão: ${u.port}`);
  }
  return url;
}

/** Senha recusada: o host estava certo, o problema é a credencial. */
export function ehSenhaRecusada(erro) {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  return erro?.code === '28P01' || /password authentication failed/i.test(mensagem);
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
  const registrar = opcoes.registrar ?? console.log;

  // Banco local (docker-compose, CI) não tem pooler para descobrir. O host
  // direto do Supabase NÃO entra aqui: ele é IPv6 e não funciona no GitHub
  // Actions, então para ele a normalização é obrigatória.
  if (!ehDoSupabase(bruta)) {
    registrar(diagnostico(bruta, 'normalização pulada: o host não é do Supabase'));
    return { url: bruta, host: paraUrl(bruta).hostname, resolvido: false };
  }

  const ref = refDoProjeto(bruta);
  if (ref === undefined) {
    throw new Error(
      'não deu para achar o ref do projeto na string de conexão. ' +
        'Copie uma das opções de Connect no Supabase (Direct, Session pooler ou Transaction pooler).',
    );
  }

  const senha = senhaDaUrl(bruta);
  if (senha === '') throw new Error('a string de conexão está sem senha');

  const motivo = motivoDaNormalizacao(bruta);
  const candidatos = candidatosDeHost(bruta, regiao);
  const tentados = [];

  for (const [i, host] of candidatos.entries()) {
    // Usuário e host saem juntos da mesma montagem, e conferirAlvo não deixa
    // passar um sem o outro.
    const url = conferirAlvo(urlDoSessionPooler({ ref, senha, host }));
    registrar(
      diagnostico(url, `${motivo} (tentativa ${String(i + 1)} de ${String(candidatos.length)})`),
    );
    try {
      await testar(url);
      return { url, host, resolvido: true };
    } catch (erro) {
      if (ehSenhaRecusada(erro)) {
        // O host respondeu: insistir nos outros trocaria um erro claro por um
        // confuso. O nome "postgres" na mensagem vem do banco por trás do
        // pooler, e já enganou uma vez.
        throw new Error(
          `o host ${host} respondeu e recusou a senha. O host está certo; ` +
            'confira a senha dentro do secret DATABASE_ADMIN_URL. ' +
            'A mensagem do Postgres cita o usuário "postgres" porque é esse o papel ' +
            `por trás do pooler, mesmo conectando como postgres.${ref}.`,
          { cause: erro },
        );
      }
      if (!ehHostErrado(erro)) throw erro;
      tentados.push(host);
    }
  }
  // Só os hosts entram na mensagem: eles não são segredo, e são o que a pessoa
  // precisa ver para entender o que foi tentado.
  throw new Error(`nenhum host do pooler respondeu. Tentados: ${tentados.join(', ')}`);
}

/** Por que a normalização foi aplicada — o que muda conforme a forma colada. */
function motivoDaNormalizacao(bruta) {
  const u = paraUrl(bruta);
  if (HOST_DIRETO.test(u.hostname)) {
    return 'normalização aplicada: a conexão direta é IPv6 e não chega do GitHub Actions';
  }
  if (u.port === String(PORTA_SESSAO)) {
    return 'normalização aplicada: host confirmado a partir da própria string';
  }
  return 'normalização aplicada: a migração precisa do modo sessão, na porta 5432';
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
