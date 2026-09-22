import { z } from 'zod';

const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  // O modelo é configuração, não código: trocar não exige publicar de novo.
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  LOG_LEVEL: z.string().default('info'),
});

export type ConfigWorker = z.infer<typeof Ambiente>;

export function lerConfigWorker(env: NodeJS.ProcessEnv = process.env): ConfigWorker {
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    throw new Error(
      `configuração inválida: ${r.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return r.data;
}
