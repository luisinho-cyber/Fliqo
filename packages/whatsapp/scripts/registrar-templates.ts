/**
 * Registra na Meta os templates de `src/templates.ts`.
 *
 * Idempotente por construção: primeiro LÊ os templates que a conta já tem e só submete os
 * que faltam. Rodar de novo é seguro e é o uso normal — você roda, a Meta leva de minutos a
 * dias para aprovar, e você roda outra vez para ver em que pé está cada um.
 *
 * Isto NÃO é um serviço. Roda do seu terminal, uma vez por conta de WhatsApp Business, e as
 * duas variáveis que ele lê não vão para o Railway nem para o CI: um runner que pode criar
 * template na sua conta da Meta é uma superfície nova para não ganhar nada.
 *
 *   WHATSAPP_WABA_ID=... WHATSAPP_TOKEN=... npm run whatsapp:registrar-templates
 *
 * O token precisa da permissão `whatsapp_business_management` — a de ENVIAR mensagem não
 * serve para criar template, e a Meta responde isso com um erro de permissão que o script
 * repassa inteiro.
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  conferirCorpo,
  corpoDoRegistro,
  todasAsDefinicoes,
  type DefinicaoDeTemplate,
} from '../src/templates';

const Ambiente = z.object({
  WHATSAPP_WABA_ID: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
  META_GRAPH_BASE: z.string().min(1).default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z.string().min(1).default('v21.0'),
});

export interface TemplateNaMeta {
  name: string;
  language: string;
  status: string;
  category?: string;
}

export type Veredito =
  | { template: string; situacao: 'ja_existe'; status: string }
  | { template: string; situacao: 'criado' }
  | { template: string; situacao: 'falhou'; detalhe: string };

interface RespostaDaLista {
  data?: TemplateNaMeta[];
  paging?: { next?: string };
  error?: { message?: string; code?: number };
}

interface RespostaDaCriacao {
  id?: string;
  status?: string;
  error?: { message?: string; code?: number; error_subcode?: number };
}

/** A Meta pagina a lista. Sem seguir o `next`, o script recriaria o que já existe. */
export async function listarExistentes(
  cfg: z.infer<typeof Ambiente>,
  buscar: typeof fetch = fetch,
): Promise<TemplateNaMeta[]> {
  const campos = 'name,language,status,category';
  let url: string | undefined =
    `${cfg.META_GRAPH_BASE}/${cfg.META_GRAPH_VERSION}/${cfg.WHATSAPP_WABA_ID}` +
    `/message_templates?fields=${campos}&limit=100`;

  const todos: TemplateNaMeta[] = [];
  while (url !== undefined) {
    const r = await buscar(url, { headers: { authorization: `Bearer ${cfg.WHATSAPP_TOKEN}` } });
    const dados = (await r.json()) as RespostaDaLista;
    if (!r.ok) {
      throw new Error(
        `a Meta recusou a leitura dos templates da conta ${cfg.WHATSAPP_WABA_ID}: ` +
          (dados.error?.message ?? `http ${String(r.status)}`),
      );
    }
    todos.push(...(dados.data ?? []));
    url = dados.paging?.next;
  }
  return todos;
}

/**
 * "Já existe" também pode vir como erro, e não só da lista.
 *
 * Duas submissões em paralelo, ou um template criado entre a leitura e o POST, caem aqui. O
 * script não pode quebrar por isso: o resultado desejado — o template existir — aconteceu.
 */
function ehNomeRepetido(erro: RespostaDaCriacao['error']): boolean {
  const mensagem = (erro?.message ?? '').toLowerCase();
  return mensagem.includes('already exists') || erro?.error_subcode === 2_388_023;
}

export async function registrarUm(
  cfg: z.infer<typeof Ambiente>,
  def: DefinicaoDeTemplate,
  buscar: typeof fetch = fetch,
): Promise<Veredito> {
  const r = await buscar(
    `${cfg.META_GRAPH_BASE}/${cfg.META_GRAPH_VERSION}/${cfg.WHATSAPP_WABA_ID}/message_templates`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.WHATSAPP_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(corpoDoRegistro(def)),
    },
  );
  const dados = (await r.json()) as RespostaDaCriacao;

  if (r.ok) return { template: def.nome, situacao: 'criado' };
  if (ehNomeRepetido(dados.error)) {
    return { template: def.nome, situacao: 'ja_existe', status: 'desconhecido' };
  }
  return {
    template: def.nome,
    situacao: 'falhou',
    detalhe: dados.error?.message ?? `http ${String(r.status)}`,
  };
}

export async function registrarTodos(
  cfg: z.infer<typeof Ambiente>,
  buscar: typeof fetch = fetch,
  definicoes: readonly DefinicaoDeTemplate[] = todasAsDefinicoes(),
): Promise<Veredito[]> {
  /*
   * Confere o catálogo inteiro ANTES de submeter qualquer coisa. Submissão recusada por
   * corpo inválido não é grave; submissão APROVADA com corpo que o código não consegue
   * preencher é, porque a aprovação leva dias e a correção leva outros tantos.
   */
  const invalidos = definicoes
    .map((def) => ({ def, problemas: conferirCorpo(def) }))
    .filter((x) => x.problemas.length > 0);
  if (invalidos.length > 0) {
    const lista = invalidos.map((x) => `${x.def.nome}: ${x.problemas.join(', ')}`).join('; ');
    throw new Error(`o catálogo tem template inválido, e nada foi submetido — ${lista}`);
  }

  const existentes = await listarExistentes(cfg, buscar);
  const vereditos: Veredito[] = [];

  for (const def of definicoes) {
    const ja = existentes.find((t) => t.name === def.nome && t.language === def.idioma);
    if (ja) {
      vereditos.push({ template: def.nome, situacao: 'ja_existe', status: ja.status });
      continue;
    }
    vereditos.push(await registrarUm(cfg, def, buscar));
  }
  return vereditos;
}

export function lerAmbiente(env: NodeJS.ProcessEnv = process.env): z.infer<typeof Ambiente> {
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    const faltando = r.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `registrar-templates precisa de ${faltando}. ` +
        'WHATSAPP_WABA_ID está em Meta > WhatsApp > API Setup (ID da conta do WhatsApp ' +
        'Business). WHATSAPP_TOKEN é o mesmo token do worker, e ele precisa da permissão ' +
        'whatsapp_business_management. Passe as duas na linha de comando; elas não moram ' +
        'em arquivo nem em serviço.',
    );
  }
  return r.data;
}

/** A linha que o terminal mostra. Nunca inclui token: só nome de template e situação. */
export function linhaDoVeredito(v: Veredito): string {
  if (v.situacao === 'criado') return `criado    ${v.template} (aguardando revisão da Meta)`;
  if (v.situacao === 'ja_existe') return `já existe ${v.template} — status na Meta: ${v.status}`;
  return `FALHOU    ${v.template}: ${v.detalhe}`;
}

async function principal(): Promise<void> {
  const cfg = lerAmbiente();
  const vereditos = await registrarTodos(cfg);
  for (const v of vereditos) process.stdout.write(`${linhaDoVeredito(v)}\n`);

  const falhas = vereditos.filter((v) => v.situacao === 'falhou');
  if (falhas.length > 0) {
    process.stdout.write(
      `\n${String(falhas.length)} template(s) não foram registrados. ` +
        'Corrija e rode de novo: os que já existem são pulados.\n',
    );
    process.exitCode = 1;
  }
}

/*
 * Só roda quando é o script chamado direto. Os testes importam as funções daqui e não
 * podem disparar um POST para a Meta por efeito colateral de importar.
 */
const chamado = process.argv[1];
if (chamado !== undefined && import.meta.url === pathToFileURL(chamado).href) {
  principal().catch((erro: unknown) => {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exitCode = 1;
  });
}
