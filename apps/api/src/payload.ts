import { z } from 'zod';

/**
 * Só o que precisamos do webhook da Meta. Tudo é opcional de propósito: um campo
 * novo ou um tipo de mensagem desconhecido não pode derrubar a rota — a Meta
 * reenviaria o evento para sempre. O que não reconhecemos é ignorado, com 200.
 */
const MensagemMeta = z.object({
  id: z.string(),
  from: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string() }).optional(),
      list_reply: z.object({ id: z.string() }).optional(),
    })
    .optional(),
});

const MudancaMeta = z.object({
  field: z.string().optional(),
  value: z
    .object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      messages: z.array(MensagemMeta).optional(),
    })
    .optional(),
});

export const PayloadWebhook = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({ changes: z.array(MudancaMeta).optional() })).optional(),
});

export type PayloadWebhook = z.infer<typeof PayloadWebhook>;

export interface MensagemRecebida {
  wamid: string;
  /** Como a Meta mandou. Normalizar é trabalho de normalizarTelefoneBR, no repositório. */
  telefone: string;
  texto?: string;
  payloadBotao?: string;
  tipoMidia?: 'audio' | 'imagem' | 'documento';
}

export interface LoteRecebido {
  phoneNumberId: string;
  mensagens: MensagemRecebida[];
}

const MIDIA: Record<string, 'audio' | 'imagem' | 'documento' | undefined> = {
  audio: 'audio',
  voice: 'audio',
  image: 'imagem',
  document: 'documento',
};

/** Resposta de botão chega com id/payload fixo: sem IA, sem interpretar texto. */
function botao(m: z.infer<typeof MensagemMeta>): string | undefined {
  return m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
}

/** Extrai os lotes por número. Eventos de status (entregue/lido) não viram nada. */
export function extrair(payload: PayloadWebhook): LoteRecebido[] {
  const lotes: LoteRecebido[] = [];

  for (const entrada of payload.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      const phoneNumberId = mudanca.value?.metadata?.phone_number_id;
      const brutas = mudanca.value?.messages ?? [];
      if (phoneNumberId === undefined || brutas.length === 0) continue;

      const mensagens = brutas.map((m) => {
        return {
          wamid: m.id,
          telefone: m.from,
          ...(m.text?.body === undefined ? {} : { texto: m.text.body }),
          ...(botao(m) === undefined ? {} : { payloadBotao: botao(m) }),
          ...(MIDIA[m.type] === undefined ? {} : { tipoMidia: MIDIA[m.type] }),
        } as MensagemRecebida;
      });

      lotes.push({ phoneNumberId, mensagens });
    }
  }

  return lotes;
}
