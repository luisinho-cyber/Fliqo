import { z } from 'zod';

/**
 * Ferramentas que o agente pode chamar. Princípio: a IA PEDE, o código DECIDE.
 *
 * - A IA nunca recebe nem envia clinic_id ou patient_id. O executor injeta os dois a partir
 *   da conversa (que já está amarrada ao número de WhatsApp). Assim, nenhum texto do paciente
 *   ("marca no nome da Maria") consegue mexer na agenda de outra pessoa ou de outra clínica.
 * - Toda entrada é validada por Zod antes de tocar no banco. Inválido -> erro devolvido à IA.
 * - Horário só pode ser marcado se veio de `buscar_horarios` nesta mesma conversa
 *   (o executor guarda os horários ofertados e recusa qualquer outro).
 */

const isoDateTime = z.string().datetime({ offset: true });

export const Ferramentas = {
  buscar_horarios: {
    descricao:
      'Lista horários livres para um procedimento. Use antes de sugerir qualquer horário. ' +
      'Nunca sugira horário que não veio desta ferramenta.',
    entrada: z.object({
      procedimento_id: z.string().uuid(),
      a_partir_de: z.string().date().describe('AAAA-MM-DD'),
      periodo: z.enum(['manha', 'tarde', 'noite', 'qualquer']).default('qualquer'),
    }),
  },
  marcar_consulta: {
    descricao: 'Marca a consulta num horário que veio de buscar_horarios. Só use depois que o paciente escolheu.',
    entrada: z.object({ procedimento_id: z.string().uuid(), inicio: isoDateTime }),
  },
  minhas_consultas: {
    descricao: 'Lista as próximas consultas do paciente desta conversa.',
    entrada: z.object({}),
  },
  remarcar_consulta: {
    descricao: 'Move uma consulta do paciente para um novo horário vindo de buscar_horarios. O horário antigo só é liberado depois que o novo estiver garantido.',
    entrada: z.object({ consulta_id: z.string().uuid(), novo_inicio: isoDateTime }),
  },
  cancelar_consulta: {
    descricao: 'Cancela uma consulta do paciente. Confirme com o paciente antes de chamar.',
    entrada: z.object({ consulta_id: z.string().uuid(), motivo: z.string().max(200) }),
  },
  entrar_lista_espera: {
    descricao: 'Coloca o paciente na lista de espera quando não há horário bom para ele.',
    entrada: z.object({
      procedimento_id: z.string().uuid(),
      de: z.string().date(),
      ate: z.string().date(),
    }),
  },
  transferir_para_humano: {
    descricao:
      'Passa a conversa para a equipe. Use quando: o paciente pedir; houver reclamação; dúvida clínica; ' +
      'assunto de dinheiro fora da tabela; qualquer coisa que você não tenha certeza.',
    entrada: z.object({
      motivo: z.enum(['pedido_do_paciente', 'reclamacao', 'duvida_clinica', 'financeiro', 'incerteza', 'urgencia']),
      resumo: z.string().max(300).describe('Resumo em 1–2 frases para a recepção não precisar ler tudo'),
    }),
  },
} as const;

export type NomeFerramenta = keyof typeof Ferramentas;

/** Formato de tool da API da Anthropic. */
export function definicoesParaApi() {
  return (Object.keys(Ferramentas) as NomeFerramenta[]).map((nome) => ({
    name: nome,
    description: Ferramentas[nome].descricao,
    input_schema: zodParaJsonSchema(Ferramentas[nome].entrada),
  }));
}

export type ResultadoValidacao =
  | { ok: true; nome: NomeFerramenta; entrada: unknown }
  | { ok: false; erro: string };

/** Valida a chamada da IA antes de qualquer efeito. */
export function validarChamada(nome: string, entrada: unknown): ResultadoValidacao {
  if (!(nome in Ferramentas)) return { ok: false, erro: `ferramenta desconhecida: ${nome}` };
  const n = nome as NomeFerramenta;
  const r = Ferramentas[n].entrada.safeParse(entrada ?? {});
  if (!r.success) return { ok: false, erro: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  // Campos que não estão no schema (ex.: um clinic_id que a IA tentou mandar) são descartados pelo Zod.
  return { ok: true, nome: n, entrada: r.data };
}

// Conversor mínimo para os tipos usados acima (mantém o pacote sem dependência extra).
function zodParaJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: string };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodParaJsonSchema(v);
        if (!v.isOptional()) required.push(k);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodString': {
      const checks = (schema._def as { checks: { kind: string }[] }).checks.map((c) => c.kind);
      const out: Record<string, unknown> = { type: 'string' };
      if (checks.includes('uuid')) out.format = 'uuid';
      if (checks.includes('datetime')) out.format = 'date-time';
      if (checks.includes('date')) out.format = 'date';
      if (schema.description) out.description = schema.description;
      return out;
    }
    case 'ZodEnum':
      return { type: 'string', enum: (schema as z.ZodEnum<[string, ...string[]]>).options };
    case 'ZodDefault':
      return zodParaJsonSchema((schema._def as { innerType: z.ZodTypeAny }).innerType);
    default:
      throw new Error(`tipo Zod não suportado no conversor: ${def.typeName}`);
  }
}
