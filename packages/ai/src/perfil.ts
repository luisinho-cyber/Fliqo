import { z } from 'zod';

/** Uma faixa de atendimento: 0 = domingo … 6 = sábado, hora local da clínica. */
const FaixaDeExpedienteSchema = z.object({
  diaDaSemana: z.number().int().min(0).max(6),
  de: z.string().regex(/^\d{2}:\d{2}$/),
  ate: z.string().regex(/^\d{2}:\d{2}$/),
});

/** Comercial brasileiro: o ponto de partida do onboarding, ajustado por clínica. */
const EXPEDIENTE_PADRAO = [1, 2, 3, 4, 5].flatMap((diaDaSemana) => [
  { diaDaSemana, de: '08:00', ate: '12:00' },
  { diaDaSemana, de: '13:00', ate: '19:00' },
]);

/**
 * Tudo que muda de uma clínica para outra mora AQUI — nunca no código, nunca no prompt fixo.
 * O fundador preenche isso numa tela de onboarding (20 min por clínica) e o sistema salva
 * como uma nova versão em app.ai_profiles. Voltar para a versão anterior = 1 clique.
 */
export const PerfilClinicaSchema = z.object({
  clinica: z.object({
    nome: z.string().min(2),
    especialidade: z.string().min(2), // 'odontologia e harmonização facial'
    endereco: z.string().min(5),
    comoChegar: z.string().optional(), // estacionamento, ponto de referência
  }),
  persona: z.object({
    nome: z.string().min(2).max(30), // 'Juliana'
    tratamento: z.enum(['voce', 'senhor_senhora']), // como chama o paciente
    tom: z.enum(['acolhedor', 'profissional', 'descontraido']),
    usaEmoji: z.boolean().default(false),
  }),
  atendimento: z.object({
    horarioHumano: z.string(), // 'seg a sex, 8h às 19h; sáb 8h às 12h' — texto, para a IA dizer ao paciente
    iaForaDoExpediente: z.boolean().default(true), // responde de madrugada?
    respondeAudioComAudio: z.boolean().default(false),
    // A mesma informação em forma de máquina: é daqui que saem os horários que a
    // IA pode oferecer. Texto livre não serve para calcular vaga.
    expediente: z.array(FaixaDeExpedienteSchema).default(EXPEDIENTE_PADRAO),
    // Antecedência mínima entre agora e o horário oferecido: ninguém chega em 10 min.
    antecedenciaMinimaMin: z.number().int().min(15).max(1_440).default(120),
  }),
  politicas: z.object({
    cancelamento: z.string(), // 'avisar com 24h; falta sem aviso cobra 50% na próxima'
    formasDePagamento: z.array(z.string()).min(1),
    convenios: z.array(z.string()).default([]), // vazio = só particular
    primeiraConsulta: z.string().optional(), // 'avaliação gratuita de 30 min'
    // Algumas clínicas só falam preço na avaliação. Falso esconde a tabela da IA.
    precoNoWhatsapp: z.boolean().default(true),
  }),
  faq: z
    .array(z.object({ pergunta: z.string().min(3), resposta: z.string().min(3) }))
    .max(40)
    .default([]),
  // Assuntos que a IA nunca aborda nesta clínica (além das proibições globais)
  proibicoesExtras: z.array(z.string()).default([]),
  // Palavras que, nesta clínica, sempre chamam um humano (ex.: 'reembolso', 'processo')
  gatilhosHumanoExtras: z.array(z.string()).default([]),
  ritmo: z
    .object({
      minRespostaMs: z.number().int().min(1_000).max(60_000),
      maxRespostaMs: z.number().int().min(5_000).max(300_000),
      caracteresPorSegundo: z.number().min(2).max(10),
    })
    .default({ minRespostaMs: 4_000, maxRespostaMs: 45_000, caracteresPorSegundo: 4 }),
});

export type PerfilClinica = z.infer<typeof PerfilClinicaSchema>;

/** Procedimento como a IA enxerga: vem do banco (app.procedures), nunca do perfil. */
export interface ProcedimentoVisivel {
  id: string;
  nome: string;
  duracaoMin: number;
  precoCentavos: number;
  exibirPreco: boolean; // algumas clínicas só falam preço na avaliação
}
