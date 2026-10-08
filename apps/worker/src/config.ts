import { z } from 'zod';

const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * Chave que decifra o token de cada clínica. Obrigatória: sem ela o worker não
   * tem como mandar mensagem em nome de ninguém.
   *
   * Não existe mais um WHATSAPP_TOKEN de ambiente. Um token único como reserva
   * seria pior do que falhar: uma clínica mal configurada passaria a mandar
   * mensagem pelo número errado, os pacientes dela receberiam de um remetente
   * estranho, e nada apareceria em log nenhum. Falha alta é melhor que envio
   * silencioso pelo remetente errado.
   */
  WHATSAPP_TOKEN_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  // O modelo é configuração, não código: trocar não exige publicar de novo.
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  // O worker atende HTTP numa rota só, /health. O Railway injeta a porta.
  PORT: z.coerce.number().int().positive().default(3100),
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
