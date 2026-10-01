import { z } from 'zod';

/**
 * Configuração vinda do ambiente. Falha no START, não na primeira requisição.
 *
 * Serviço que sobe sem segredo atende requisição e falha na hora de usá-lo, que é o
 * pior momento possível: o webhook aceitaria qualquer mensagem como se fosse da Meta,
 * ou o token de uma clínica falharia ao ser decifrado com o paciente esperando resposta.
 * Nunca subir degradado é regra, não preferência.
 *
 * A mensagem de erro diz O NOME da variável e O SERVIÇO. Quem está configurando o
 * Railway às onze da noite não deve ter de abrir o código para descobrir qual faltou.
 */
const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  // DATABASE_ADMIN_URL NÃO entra aqui de propósito, e não é esquecimento: a api
  // nunca a usou. Declarar uma variável que o serviço não usa ensina a quem lê
  // que ela é necessária, e daí ela acaba configurada no Railway. Quem recusa é
  // `recusarAdminUrl`, no caminho de start (apps/api/src/index.ts).
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  /**
   * Segredo com que o Supabase assina os tokens do painel.
   *
   * Tem de ser O SEGREDO QUE O SUPABASE EMITIU, não um valor aleatório — e esta é a
   * única variável do produto em que gerar um valor novo produz um sintoma mentiroso:
   * o login falha com "senha errada" usando a senha certa, para todo mundo, e nada no
   * log aponta para a configuração. `pareceCopiadoDoSupabase` existe por isso.
   */
  SUPABASE_JWT_SECRET: z
    .string()
    .min(32, 'curto demais para assinar token: confira se copiou inteiro')
    .refine(pareceCopiadoDoSupabase, {
      message:
        'parece um valor gerado, não o do Supabase — pegue em Supabase > Project Settings > API > JWT Secret, não gere',
    }),
  // Embedded Signup: o segredo do app é o que torna o código do navegador útil.
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  // Chave de 32 bytes em base64 para cifrar o token da clínica.
  WHATSAPP_TOKEN_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
});

/**
 * O JWT Secret do Supabase é alfanumérico. `openssl rand -base64 32` e os geradores
 * de senha produzem `+`, `/` e `=`, que não aparecem nele.
 *
 * É heurística, e ela derruba o processo de propósito: entre não subir com uma
 * mensagem exata e subir com todo login falhando sem explicação, não subir é melhor.
 * O que a inverteria é o Supabase passar a emitir segredo em base64 — nesse dia, troque
 * a regra aqui e a linha correspondente no DEPLOY.md, juntas.
 */
export function pareceCopiadoDoSupabase(valor: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(valor);
}

export type Config = z.infer<typeof Ambiente>;

/**
 * Os nomes que este serviço lê do ambiente, para o contrato com o DEPLOY.md.
 *
 * Saem do próprio schema: lista escrita à mão ao lado dele divergiria dele, que é
 * exatamente o problema que o contrato existe para resolver.
 */
export const VARIAVEIS_DA_API: readonly string[] = Object.keys(Ambiente.shape);

/** As que têm padrão no código: faltar não derruba o serviço. */
export const OPCIONAIS_DA_API: readonly string[] = Object.entries(Ambiente.shape)
  .filter(([, campo]) => campo.safeParse(undefined).success)
  .map(([nome]) => nome);

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    // Nome e motivo de CADA problema, não só o primeiro: quem configurou errado
    // duas variáveis não deve descobrir a segunda no deploy seguinte.
    const problemas = r.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join('; ');
    throw new Error(`configuração inválida da api: ${problemas}`);
  }
  return r.data;
}
