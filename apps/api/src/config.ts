import { z } from 'zod';

/**
 * Configuração vinda do ambiente. Falha no start, não na primeira requisição:
 * subir sem o segredo do webhook significaria aceitar qualquer mensagem.
 */
const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  // Segredo com que o Supabase assina os tokens do painel.
  SUPABASE_JWT_SECRET: z.string().min(1),
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
