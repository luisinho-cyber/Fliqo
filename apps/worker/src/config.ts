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
  /**
   * O vigia de operador (0015). As três andam juntas: sem qualquer uma delas o e-mail não
   * sai, e um vigia que não avisa é pior do que não ter vigia — ele dá a impressão de que
   * alguém está olhando.
   *
   * A CHAVE É SEGREDO e mora só no serviço worker do Railway, em env. Nunca em arquivo do
   * repositório, nunca no CI: um runner que pode mandar e-mail em nome da Fliqo é superfície
   * nova sem nada em troca.
   */
  EMAIL_API_KEY: z.string().min(1),
  EMAIL_REMETENTE: z.string().min(1),
  OPERADOR_EMAIL: z.string().min(1),
  /** Endpoint do provedor. Tem padrão para o caminho comum não precisar de configuração. */
  EMAIL_API_URL: z.string().min(1).default('https://api.resend.com/emails'),
  /**
   * Fuso do OPERADOR, para o vigia não mandar e-mail às três da manhã. Da pessoa que recebe,
   * não da clínica: é a caixa de entrada dela que toca.
   */
  OPERADOR_FUSO: z.string().min(1).default('America/Sao_Paulo'),
  /**
   * O token do `/estado`. SEGREDO, só no serviço worker do Railway, gerado com
   * `openssl rand -base64 32` no terminal de quem configura — nunca em arquivo.
   *
   * Opcional de propósito: ausente, o `/estado` responde 404 a todos (fechado, não aberto), e
   * o deploy que chega antes de a variável ser criada não cai. Presente e curto, o worker não
   * sobe: token fraco num painel de operação é pior do que painel nenhum.
   */
  ESTADO_TOKEN: z.string().min(32).optional(),
  // O worker atende HTTP em /health (público) e /estado (com token). O Railway injeta a porta.
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
