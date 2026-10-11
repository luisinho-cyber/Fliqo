/**
 * As variáveis de ambiente de cada serviço, declaradas UMA vez.
 *
 * Antes isto existia em três lugares que discordavam: a validação na subida de cada app, a
 * tabela do DEPLOY.md e o que estava de fato no Railway. Três deploys quebrados em sequência
 * saíram dessa divergência — cada um revelando uma variável diferente.
 *
 * Daqui saem quatro coisas, e é isso que impede a volta da divergência:
 *
 *   1. a validação na subida (`lerAmbiente`), que diz TODAS as que faltam de uma vez;
 *   2. o tipo da configuração de cada serviço, por inferência — não há lista repetida;
 *   3. o tipo de `process.env`, que faz `process.env.NAO_DECLARADA` reprovar no typecheck;
 *   4. as tabelas do DEPLOY.md, geradas por script e conferidas por teste.
 *
 * Fica em `core` porque `core` não importa nada: os três apps podem depender dele, e ele não
 * depende de nenhum. Sem biblioteca de validação, de propósito — o que se valida aqui é um
 * punhado de strings, e `core` não tem dependência externa nenhuma.
 */

/** Como o valor é entregue a quem lê a configuração. */
export type TipoDaVariavel = 'texto' | 'numero';

export interface FormatoDaVariavel {
  /** Em uma linha, para a tabela do DEPLOY.md e para a mensagem de erro. */
  descricao: string;
  /** Devolve o motivo da recusa, ou `undefined` quando o valor serve. */
  conferir: (valor: string) => string | undefined;
}

export interface VariavelDeAmbiente {
  readonly nome: string;
  readonly tipo: TipoDaVariavel;
  /** Sem ela o serviço NÃO sobe. */
  readonly obrigatoria: boolean;
  /** Vale quando a variável não é obrigatória e o código tem um valor de partida. */
  readonly padrao?: string | number;
  /** De onde o valor vem, para quem está configurando o serviço. */
  readonly origem: string;
  /** Por que este serviço precisa dela. Entra na tabela do DEPLOY.md. */
  readonly porque: string;
  readonly formato?: FormatoDaVariavel;
  /** Segredo: nunca sai em log, em corpo de erro nem em exemplo. */
  readonly segredo?: boolean;
}

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------

/**
 * A conexão da aplicação, que é do papel `fliqo_app` — nunca do dono do schema.
 *
 * O dono não passa pela RLS (CLAUDE.md, regra 2), então uma `DATABASE_URL` de administrador
 * apagaria a separação entre clínicas sem erro nenhum: as consultas funcionariam, e
 * enxergariam tudo. Quem recusa a `DATABASE_ADMIN_URL` no ambiente é `recusarAdminUrl`, no
 * caminho de start; aqui o que se confere é o papel DENTRO da própria `DATABASE_URL`.
 */
export const URL_DA_APLICACAO: FormatoDaVariavel = {
  descricao: 'postgresql://fliqo_app:senha@host:porta/banco (o papel da aplicação, nunca o dono)',
  conferir: (valor) => {
    if (!/^postgres(ql)?:\/\//.test(valor)) return 'não parece uma conexão postgresql://';

    const partes = /^postgres(?:ql)?:\/\/([^:@/]+)(?::([^@]*))?@([^/?]+)(?:\/([^?]*))?/.exec(valor);
    if (partes === null) return 'não dá para separar usuário, host e banco';
    const [, usuario, senha, hostEPorta, banco] = partes;
    if (usuario === undefined) return 'sem usuário na conexão';

    // O pooler do Supabase usa `papel.ref-do-projeto`; o papel é o que vem antes do ponto.
    const papel = usuario.split('.')[0];
    if (papel !== 'fliqo_app') {
      return `conecta como "${papel ?? '?'}", e a aplicação conecta como fliqo_app — o dono do schema não passa pela RLS`;
    }

    /*
     * O espaço reservado colado é conferido ANTES de qualquer tentativa de conexão: sem isto
     * ele vira "host não encontrado" no start, que é a mesma mensagem de rede ruim — e foram
     * quatro deploys até alguém olhar o valor.
     */
    return (
      caixaAltaOndeNaoCabe(hostEPorta ?? '', 'host') ??
      caixaAltaOndeNaoCabe(banco ?? 'postgres', 'nome do banco') ??
      espacoReservado(senha ?? '', 'senha') ??
      espacoReservado(usuario, 'usuário')
    );
  },
};

/**
 * Espaço reservado colado literalmente, que é falha de configuração e não de valor.
 *
 * Quatro deploys seguidos da api caíram porque a `DATABASE_URL` levava o texto
 * `HOST_DO_POOLER` — um espaço reservado escrito num passo a passo e colado inteiro. O
 * formato da conexão não via nada de errado: o papel era `fliqo_app`, o esquema era
 * `postgresql://`, e só o host era inventado. O Postgres respondia "host não encontrado", que
 * é a mesma mensagem de uma rede ruim.
 *
 * As três formas que um espaço reservado toma: `<entre-sinais>`, `[ENTRE_COLCHETES]` e
 * `CAIXA_ALTA_COM_SUBLINHADO` solta. A última é a arriscada de detectar — senha de verdade
 * pode ser maiúscula —, então ela só vale onde não cabe: no HOST e no NOME DO BANCO, que são
 * minúsculos e com ponto ou hífen. Senha é conferida só pelas duas primeiras formas, porque
 * `SENHA_MUITO_FORTE_2026` é uma senha plausível e recusá-la seria pior.
 */
function espacoReservado(valor: string, onde: string): string | undefined {
  if (/[<>]/.test(valor)) {
    return `"${onde}" tem < ou >: isso é um espaço reservado, não um valor`;
  }
  // O hífen entra porque `[YOUR-PASSWORD]` é o espaço reservado do próprio Supabase, e é o
  // mais provável de ser colado inteiro. Exigir letra no começo deixa passar `[::1]`, que é
  // host IPv6 de verdade.
  if (/\[[A-Za-z][A-Za-z0-9_-]*\]/.test(valor)) {
    return `"${onde}" está entre colchetes: isso é um espaço reservado, não um valor`;
  }
  return undefined;
}

/** Em host e nome de banco, uma palavra em CAIXA_ALTA com sublinhado nunca é valor real. */
function caixaAltaOndeNaoCabe(valor: string, onde: string): string | undefined {
  const reservado = espacoReservado(valor, onde);
  if (reservado !== undefined) return reservado;
  const segmentos = valor.split(/[.\-/:]/);
  const gritando = segmentos.find((s) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s));
  return gritando === undefined
    ? undefined
    : `"${onde}" contém "${gritando}": isso é um espaço reservado, não um valor`;
}

/** Chave de 32 bytes em base64: é o tamanho que o AES-256-GCM do cofre exige. */
export const CHAVE_BASE64_32: FormatoDaVariavel = {
  descricao: '32 bytes em base64 (44 caracteres terminando em "=")',
  conferir: (valor) => {
    const bytes = Buffer.from(valor, 'base64').length;
    return bytes === 32 ? undefined : `precisa ter 32 bytes em base64, tem ${String(bytes)}`;
  },
};

export function minimoDeCaracteres(minimo: number): FormatoDaVariavel {
  return {
    descricao: `pelo menos ${String(minimo)} caracteres`,
    conferir: (valor) =>
      valor.length >= minimo
        ? undefined
        : `precisa de pelo menos ${String(minimo)} caracteres, tem ${String(valor.length)}`,
  };
}

/** Endereço http(s) sem barra no fim: quem monta o caminho depois é quem chama. */
export const ENDERECO_HTTP: FormatoDaVariavel = {
  descricao: 'https://… (a barra no fim é tolerada e removida por quem lê)',
  conferir: (valor) => {
    if (!/^https?:\/\/[^\s]+$/.test(valor)) return 'não parece um endereço http(s)';
    const host = /^https?:\/\/([^/?#]+)/.exec(valor)?.[1] ?? '';
    return caixaAltaOndeNaoCabe(host, 'host');
  },
};

export const FUSO_IANA: FormatoDaVariavel = {
  descricao: 'fuso IANA, ex. America/Sao_Paulo',
  conferir: (valor) => (valor.includes('/') ? undefined : 'não parece um fuso IANA'),
};

// ---------------------------------------------------------------------------
// As variáveis compartilhadas, escritas uma vez
// ---------------------------------------------------------------------------

const DATABASE_URL = {
  nome: 'DATABASE_URL',
  tipo: 'texto',
  obrigatoria: true,
  origem:
    'Transaction pooler do Supabase, com o usuário trocado para fliqo_app (DEPLOY.md, passo 4)',
  porque: 'o painel não fala com o banco (CLAUDE.md, regra 10)',
  formato: URL_DA_APLICACAO,
  segredo: true,
} as const satisfies VariavelDeAmbiente;

const WHATSAPP_TOKEN_KEY = {
  nome: 'WHATSAPP_TOKEN_KEY',
  tipo: 'texto',
  obrigatoria: true,
  origem: 'você gera (DEPLOY.md, logo abaixo da tabela da API)',
  porque:
    'a api cifra o token que a clínica conecta; o worker passa a decifrar na fase de resiliência',
  formato: CHAVE_BASE64_32,
  segredo: true,
} as const satisfies VariavelDeAmbiente;

const META_APP_ID = {
  nome: 'META_APP_ID',
  tipo: 'texto',
  obrigatoria: true,
  origem: 'Meta > seu app > Configurações básicas',
  porque: 'a api troca o código do Embedded Signup; o painel abre a janela',
} as const satisfies VariavelDeAmbiente;

const PORT = (padrao: number) =>
  ({
    nome: 'PORT',
    tipo: 'numero',
    obrigatoria: false,
    padrao,
    origem: 'o Railway injeta; cadastre à mão só se usar "Target port" no domínio',
    porque: 'a porta em que o serviço escuta, e a mesma que o health check consulta',
  }) as const satisfies VariavelDeAmbiente;

const LOG_LEVEL = {
  nome: 'LOG_LEVEL',
  tipo: 'texto',
  obrigatoria: false,
  padrao: 'info',
  origem: '`info`',
  porque: 'nível do logger',
} as const satisfies VariavelDeAmbiente;

// ---------------------------------------------------------------------------
// Os três esquemas
// ---------------------------------------------------------------------------

export const AMBIENTE_DA_API = [
  DATABASE_URL,
  {
    nome: 'WHATSAPP_APP_SECRET',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'Meta > seu app > Configurações básicas > Chave secreta do app',
    porque: 'valida a assinatura do webhook, que chega na api',
    segredo: true,
  },
  {
    nome: 'WHATSAPP_VERIFY_TOKEN',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'uma frase inventada por você; a MESMA vai no webhook da Meta',
    porque: 'a Meta a devolve na verificação do webhook',
    segredo: true,
  },
  {
    nome: 'SUPABASE_JWT_SECRET',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'Supabase > Project Settings > API > JWT Secret',
    porque: 'quem verifica o token do painel é a api',
    segredo: true,
  },
  META_APP_ID,
  {
    nome: 'META_APP_SECRET',
    tipo: 'texto',
    obrigatoria: true,
    origem:
      'Meta > seu app > Configurações básicas > Chave secreta do app (o mesmo valor de WHATSAPP_APP_SECRET quando é o mesmo app)',
    porque: 'só a api: é o que torna o código do navegador útil',
    segredo: true,
  },
  WHATSAPP_TOKEN_KEY,
  PORT(3000),
  LOG_LEVEL,
] as const satisfies readonly VariavelDeAmbiente[];

/**
 * O worker DE HOJE (main). Ele envia com um token único de ambiente.
 *
 * O token por clínica — `WHATSAPP_TOKEN_KEY` no lugar de `WHATSAPP_TOKEN` — e o vigia de
 * operador (as três de e-mail) chegam com a fase de resiliência. Declarar aqui o que ainda
 * não foi mesclado faria o worker RECUSAR subir por falta de variável que o código não lê.
 * Quando aquela fase entrar, o typecheck cobra a troca: o `index.ts` deixa de compilar.
 */
export const AMBIENTE_DO_WORKER = [
  DATABASE_URL,
  {
    nome: 'WHATSAPP_TOKEN',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'Meta > WhatsApp > API Setup (token de usuário de sistema, para não expirar em 24 h)',
    porque: 'quem envia mensagem é o worker',
    segredo: true,
  },
  {
    nome: 'ANTHROPIC_API_KEY',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'painel do provedor do modelo; cole direto no Railway, e em nenhum outro lugar',
    porque: 'só o worker chama o modelo',
    segredo: true,
  },
  {
    nome: 'ANTHROPIC_MODEL',
    tipo: 'texto',
    obrigatoria: false,
    padrao: 'claude-haiku-4-5',
    origem: 'opcional',
    porque: 'o modelo é configuração, não código: trocar não exige publicar de novo',
  },
  PORT(3100),
  LOG_LEVEL,
] as const satisfies readonly VariavelDeAmbiente[];

export const AMBIENTE_DO_PAINEL = [
  {
    nome: 'API_URL',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'o domínio da api, sem barra no fim',
    porque: 'quem chama a api é o servidor do painel',
    formato: ENDERECO_HTTP,
  },
  {
    nome: 'SUPABASE_URL',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'Supabase > Project Settings > API > Project URL',
    porque: 'autenticação, no servidor do painel',
  },
  {
    nome: 'SUPABASE_ANON_KEY',
    tipo: 'texto',
    obrigatoria: true,
    origem: 'Supabase > Project Settings > API > anon public',
    porque: 'idem',
  },
  /*
   * No painel as duas do Embedded Signup são OPCIONAIS, e na api a `META_APP_ID` é
   * obrigatória. Não é descuido: quem troca o código por token é a api, e sem isso ela não
   * tem o que fazer. No painel, faltar significa uma clínica cujo ambiente ainda não foi
   * configurado, e `configDoSignup` devolve `undefined` para a tela escrever isso em
   * português — marcar como obrigatória aqui faria o esquema prometer uma recusa que leitor
   * nenhum aplica, que é a divergência que este arquivo existe para acabar.
   */
  {
    nome: 'META_APP_ID',
    tipo: 'texto',
    obrigatoria: false,
    origem: 'Meta > seu app > Configurações básicas',
    porque: 'o painel abre a janela do Embedded Signup; sem ela a tela explica que falta',
  },
  {
    nome: 'META_CONFIG_ID',
    tipo: 'texto',
    obrigatoria: false,
    origem: 'Meta > seu app > WhatsApp > Embedded Signup',
    porque: 'sem ela a tela de conexão explica que falta configurar, em vez de estourar',
  },
  {
    nome: 'NODE_ENV',
    tipo: 'texto',
    obrigatoria: false,
    padrao: 'development',
    origem: '`production` no Railway',
    porque: 'é o que faz o cookie de sessão sair como Secure',
  },
  // LOG_LEVEL fica FORA: nenhum código do painel a lê. Declarar variável que o serviço não
  // usa ensina a quem configura que ela é necessária, e daí ela aparece no Railway.
] as const satisfies readonly VariavelDeAmbiente[];

/**
 * Variáveis de FERRAMENTA: migração, scripts e CI. Nenhum serviço as lê.
 *
 * Elas entram aqui por um motivo só: o tipo de `process.env` sai desta lista mais os três
 * esquemas, e sem elas um script legítimo não compilaria. A `DATABASE_ADMIN_URL` está aqui
 * e em nenhum serviço — é o dono do schema, e `recusarAdminUrl` recusa subir com ela.
 */
export const AMBIENTE_DE_FERRAMENTA = [
  'DATABASE_ADMIN_URL',
  'FLIQO_APP_PASSWORD',
  'SUPABASE_REGION',
  'WHATSAPP_TOKEN_KEY_ANTIGA',
  'WHATSAPP_WABA_ID',
  'CHROMIUM_EXECUTAVEL',
  'CI',
] as const;

export const ESQUEMAS_DE_AMBIENTE = {
  api: AMBIENTE_DA_API,
  worker: AMBIENTE_DO_WORKER,
  painel: AMBIENTE_DO_PAINEL,
} as const;

export type NomeDeServico = keyof typeof ESQUEMAS_DE_AMBIENTE;

// ---------------------------------------------------------------------------
// O tipo da configuração, derivado do esquema
// ---------------------------------------------------------------------------

type ValorDe<V> = V extends { tipo: 'numero' } ? number : string;

/**
 * A configuração de um serviço, a partir do esquema dele.
 *
 * Obrigatória ou com padrão é sempre presente; opcional sem padrão vem `undefined`. Não existe
 * lista de nomes repetida em lugar nenhum: mexer no esquema muda o tipo, e quem lia um campo
 * que saiu deixa de compilar.
 */
export type ConfigDoEsquema<E extends readonly VariavelDeAmbiente[]> = {
  [V in E[number] as V['nome']]: V extends { obrigatoria: true }
    ? ValorDe<V>
    : V extends { padrao: string | number }
      ? ValorDe<V>
      : ValorDe<V> | undefined;
};

/** Todo nome que algum serviço ou ferramenta usa. É daqui que sai o tipo de `process.env`. */
export type NomeDeVariavel =
  | (typeof AMBIENTE_DA_API)[number]['nome']
  | (typeof AMBIENTE_DO_WORKER)[number]['nome']
  | (typeof AMBIENTE_DO_PAINEL)[number]['nome']
  | (typeof AMBIENTE_DE_FERRAMENTA)[number];

/**
 * O ambiente como os leitores de configuração o recebem.
 *
 * `string | undefined` explícito, e não `Partial`: é o que `process.env` devolve de verdade,
 * e com `exactOptionalPropertyTypes` um `Partial` recusaria quem passa a chave com
 * `undefined` — que é exatamente como um ambiente incompleto chega.
 */
export type AmbienteConhecido = { [K in NomeDeVariavel]?: string | undefined };

/*
 * `process.env` passa a conhecer estes nomes, e é por isso que os leitores de configuração
 * recebem `AmbienteConhecido` e não `NodeJS.ProcessEnv`.
 *
 * `ProcessEnv` do @types/node tem assinatura de índice: `env.QUALQUER_COISA` compila nela, e
 * declaração nossa não remove índice de interface alheia. Então quem valida configuração
 * recebe o tipo FECHADO — ali, ler um nome fora do esquema não compila. Fora dos leitores
 * (scripts, testes), quem cobra é `tests/ambiente-declarado.test.ts`, que varre o código por
 * `process.env.NOME`: foi a escolha de não ligar `noPropertyAccessFromIndexSignature` no
 * repositório inteiro, que custaria catorze trocas de ponto por colchete em código de
 * `Record` sem nenhuma relação com ambiente.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    // Interface vazia é o ponto: o corpo vem do `extends`, e é assim que a declaração se
    // funde com a do @types/node em vez de substituí-la.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProcessEnv extends AmbienteConhecido {}
  }
}

// ---------------------------------------------------------------------------
// A leitura
// ---------------------------------------------------------------------------

export interface ProblemaDeAmbiente {
  variavel: string;
  motivo: string;
}

export type LeituraDoAmbiente<T> =
  { ok: true; config: T } | { ok: false; problemas: ProblemaDeAmbiente[] };

/**
 * Lê o ambiente pelo esquema e junta TODOS os problemas.
 *
 * Uma por vez custou três deploys em sequência: cada subida revelava a variável seguinte. O
 * motivo de cada recusa entra na lista, e nenhum VALOR entra — a mensagem sobe no log do
 * Railway, e segredo não se repete em log nem em corpo de erro.
 */
export function lerAmbiente<E extends readonly VariavelDeAmbiente[]>(
  esquema: E,
  env: AmbienteConhecido,
): LeituraDoAmbiente<ConfigDoEsquema<E>> {
  const problemas: ProblemaDeAmbiente[] = [];
  const config: Record<string, string | number | undefined> = {};

  for (const v of esquema) {
    const bruto = env[v.nome as NomeDeVariavel];
    const vazio = bruto === undefined || bruto === '';

    if (vazio) {
      if (v.obrigatoria) {
        problemas.push({ variavel: v.nome, motivo: `falta — ${v.origem}` });
        continue;
      }
      config[v.nome] = v.padrao;
      continue;
    }

    const recusa = v.formato?.conferir(bruto);
    if (recusa !== undefined) {
      problemas.push({ variavel: v.nome, motivo: recusa });
      continue;
    }

    if (v.tipo === 'numero') {
      const n = Number(bruto);
      if (!Number.isInteger(n) || n <= 0) {
        problemas.push({ variavel: v.nome, motivo: 'precisa ser um número inteiro positivo' });
        continue;
      }
      config[v.nome] = n;
      continue;
    }

    config[v.nome] = bruto;
  }

  return problemas.length > 0
    ? { ok: false, problemas }
    : { ok: true, config: config as ConfigDoEsquema<E> };
}

/** A mensagem de start: uma linha por problema, todas de uma vez, sem nenhum valor. */
export function mensagemDeAmbiente(servico: string, problemas: ProblemaDeAmbiente[]): string {
  const linhas = problemas.map((p) => `  - ${p.variavel}: ${p.motivo}`);
  const quantas = problemas.length === 1 ? '1 variável' : `${String(problemas.length)} variáveis`;
  return [
    `${servico} não sobe: ${quantas} de ambiente com problema.`,
    ...linhas,
    'A lista completa está em docs/DEPLOY.md, gerada do esquema em packages/core/src/ambiente.ts.',
  ].join('\n');
}

/**
 * Um pedaço do esquema, nomeado pelos nomes dele.
 *
 * Existe para quem não tem um ponto de start onde validar tudo de uma vez: o painel é
 * renderização de servidor, e cada leitor confere só o que ele usa. O tipo dos nomes vem do
 * esquema, então pedir uma variável que não existe nele não compila — e a tabela do
 * DEPLOY.md continua saindo do esquema inteiro, não do pedaço.
 */
export function apenas<E extends readonly VariavelDeAmbiente[], N extends E[number]['nome']>(
  esquema: E,
  nomes: readonly N[],
): readonly Extract<E[number], { nome: N }>[] {
  return esquema.filter((v): v is Extract<E[number], { nome: N }> =>
    (nomes as readonly string[]).includes(v.nome),
  );
}

/** Lê, ou lança com todos os problemas. É o que o caminho de start usa. */
export function exigirAmbiente<E extends readonly VariavelDeAmbiente[]>(
  servico: string,
  esquema: E,
  env: AmbienteConhecido,
): ConfigDoEsquema<E> {
  const r = lerAmbiente(esquema, env);
  if (!r.ok) throw new Error(mensagemDeAmbiente(servico, r.problemas));
  return r.config;
}

// ---------------------------------------------------------------------------
// As tabelas do DEPLOY.md
// ---------------------------------------------------------------------------

/** Marcadores do bloco gerado, por nome. O script preenche; o teste confere. */
export function marcadores(bloco: string): { inicio: string; fim: string } {
  return { inicio: `<!-- ambiente:${bloco}:inicio -->`, fim: `<!-- ambiente:${bloco}:fim -->` };
}

function celula(texto: string): string {
  return texto.replaceAll('|', '\\|');
}

function exigencia(v: VariavelDeAmbiente): string {
  if (v.obrigatoria) return 'sim';
  return v.padrao === undefined ? 'não' : `não (padrão \`${String(v.padrao)}\`)`;
}

/** A tabela de um serviço: o que cadastrar, de onde vem e o formato quando há. */
export function tabelaDoServico(esquema: readonly VariavelDeAmbiente[]): string {
  const linhas = esquema.map((v) => {
    const formato = v.formato === undefined ? '—' : celula(v.formato.descricao);
    return `| \`${v.nome}\` | ${exigencia(v)} | ${formato} | ${celula(v.origem)} |`;
  });
  return [
    '| Variável | Obrigatória | Formato | De onde vem |',
    '| --- | --- | --- | --- |',
    ...linhas,
  ].join('\n');
}

/** A tabela cruzada: qual serviço lê cada variável, e por quê. */
export function tabelaCruzada(): string {
  const todas = new Map<string, VariavelDeAmbiente>();
  for (const esquema of Object.values(ESQUEMAS_DE_AMBIENTE)) {
    for (const v of esquema) if (!todas.has(v.nome)) todas.set(v.nome, v);
  }
  const marca = (esquema: readonly VariavelDeAmbiente[], nome: string): string =>
    esquema.some((v) => v.nome === nome) ? '✓' : '—';

  const linhas = [...todas.values()]
    .map(
      (v) =>
        `| \`${v.nome}\` | ${marca(AMBIENTE_DA_API, v.nome)} | ${marca(AMBIENTE_DO_WORKER, v.nome)} | ${marca(AMBIENTE_DO_PAINEL, v.nome)} | ${celula(v.porque)} |`,
    )
    .concat(
      AMBIENTE_DE_FERRAMENTA.map(
        (nome) =>
          `| \`${nome}\` | — | — | — | ferramenta: migração, script ou CI; nenhum serviço a lê |`,
      ),
    );

  return [
    '| Variável | api | worker | painel | Por quê |',
    '| --- | :-: | :-: | :-: | --- |',
    ...linhas,
  ].join('\n');
}

/** Os quatro blocos gerados, por nome de marcador. */
export function blocosDoDeploy(): Record<string, string> {
  return {
    api: tabelaDoServico(AMBIENTE_DA_API),
    worker: tabelaDoServico(AMBIENTE_DO_WORKER),
    painel: tabelaDoServico(AMBIENTE_DO_PAINEL),
    cruzada: tabelaCruzada(),
  };
}

/**
 * As células de uma tabela markdown, sem o espaçamento.
 *
 * O gerador escreve as colunas justas e a Prettier as realinha depois; comparar texto cru
 * faria o teste acusar diferença a cada alinhamento. O que importa é o CONTEÚDO.
 */
export function celulasDaTabela(markdown: string): string[][] {
  return markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim().replace(/\s+/g, ' '))
        .filter((c) => !/^-+:?$|^:?-+:?$/.test(c)),
    )
    .filter((cells) => cells.length > 0);
}

/** O que está hoje dentro de um bloco marcado do arquivo. */
export function blocoDoArquivo(texto: string, bloco: string): string | undefined {
  const { inicio, fim } = marcadores(bloco);
  const i = texto.indexOf(inicio);
  const f = texto.indexOf(fim);
  if (i === -1 || f === -1 || f < i) return undefined;
  return texto.slice(i + inicio.length, f);
}

/** Troca cada bloco marcado pelo conteúdo gerado. Devolve o texto novo do arquivo. */
export function aplicarBlocos(
  texto: string,
  blocos: Record<string, string> = blocosDoDeploy(),
): { texto: string; faltando: string[] } {
  let saida = texto;
  const faltando: string[] = [];

  for (const [nome, conteudo] of Object.entries(blocos)) {
    const { inicio, fim } = marcadores(nome);
    const i = saida.indexOf(inicio);
    const f = saida.indexOf(fim);
    if (i === -1 || f === -1 || f < i) {
      faltando.push(nome);
      continue;
    }
    saida = `${saida.slice(0, i + inicio.length)}\n\n${conteudo}\n\n${saida.slice(f)}`;
  }

  return { texto: saida, faltando };
}
