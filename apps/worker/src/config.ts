import { z } from 'zod';

const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
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
