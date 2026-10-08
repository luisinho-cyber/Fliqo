import { z } from 'zod';

/**
 * Configuração do worker, validada no START.
 *
 * O worker é quem envia mensagem. Subir sem o token não daria erro nenhum até a primeira
 * confirmação de hoje — e aí o erro aparece como mensagem não enviada, que a recepção
 * descobre quando o paciente não vem. Falhar no start é a única hora em que isso custa um
 * minuto em vez de um dia de agenda.
 */
const Ambiente = z.object({
  DATABASE_URL: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
  // WHATSAPP_TOKEN_KEY ainda NÃO entra aqui: hoje o worker envia com um token único
  // de ambiente, e não decifra token de clínica. Quando o cofre por clínica entrar, esta
  // linha e a do DEPLOY.md mudam JUNTAS — o contrato em tests/ quebra se uma mudar só.
  ANTHROPIC_API_KEY: z.string().min(1),
  // O modelo é configuração, não código: trocar não exige publicar de novo.
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  // O worker atende HTTP numa rota só, /health. O Railway injeta a porta.
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.string().default('info'),
});

export type ConfigWorker = z.infer<typeof Ambiente>;

/** Os nomes que este serviço lê, tirados do próprio schema. Veja o contrato em tests/. */
export const VARIAVEIS_DO_WORKER: readonly string[] = Object.keys(Ambiente.shape);

export const OPCIONAIS_DO_WORKER: readonly string[] = Object.entries(Ambiente.shape)
  .filter(([, campo]) => campo.safeParse(undefined).success)
  .map(([nome]) => nome);

export function lerConfigWorker(env: NodeJS.ProcessEnv = process.env): ConfigWorker {
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join('; ');
    throw new Error(`configuração inválida do worker: ${problemas}`);
  }
  return r.data;
}
