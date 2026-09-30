import { z } from 'zod';

/**
 * Configuração vinda do ambiente. Falha no start, não na primeira requisição:
 * subir sem o segredo do webhook significaria aceitar qualquer mensagem.
 */
const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  // DATABASE_ADMIN_URL NÃO entra aqui de propósito, e não é esquecimento: a api
  // nunca a usou. Declarar uma variável que o serviço não usa ensina a quem lê
  // que ela é necessária, e daí ela acaba configurada no Railway. Quem recusa é
  // `recusarAdminUrl`, no caminho de start (apps/api/src/index.ts).
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  // Segredo com que o Supabase assina os tokens do painel.
  SUPABASE_JWT_SECRET: z.string().min(1),
  // Embedded Signup: o segredo do app é o que torna o código do navegador útil.
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  // Chave de 32 bytes em base64 para cifrar o token da clínica.
  WHATSAPP_TOKEN_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof Ambiente>;

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    const faltando = r.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`configuração inválida: ${faltando}`);
  }
  return r.data;
}
