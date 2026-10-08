import { dataDaMensagem, horaDaMensagem } from '@fliqo/core';
import { hoje, pacientes, profissionais, type Trx } from '@fliqo/db';

/**
 * O que uma mensagem de template precisa saber além do horário: quem atende, quem recebe, e
 * como a clínica se chama.
 *
 * Existe num lugar só porque os dois call sites que mandam template com variável — a
 * confirmação e a oferta de vaga — precisam exatamente do mesmo conjunto, e duas montagens
 * da mesma mensagem divergem na primeira vez que alguém troca o formato da data.
 *
 * A data e a hora saem de `@fliqo/core`, no fuso da clínica. Uma clínica em Manaus não pode
 * receber "às 14:30" calculado em São Paulo.
 */
export interface DadosDaMensagem {
  pacienteNome: string;
  profissionalNome: string;
  clinicaNome: string;
  data: string;
  hora: string;
}

export type ResultadoDosDados =
  | { ok: true; dados: DadosDaMensagem }
  | { ok: false; motivo: 'paciente_nao_encontrado' | 'profissional_nao_encontrado' };

export async function dadosDaMensagem(
  trx: Trx,
  clinicId: string,
  consulta: { patient_id: string; professional_id: string; starts_at: Date },
): Promise<ResultadoDosDados> {
  const paciente = await pacientes.porId(trx, consulta.patient_id);
  if (!paciente) return { ok: false, motivo: 'paciente_nao_encontrado' };

  const profissional = await profissionais.porId(trx, consulta.professional_id);
  if (!profissional) return { ok: false, motivo: 'profissional_nao_encontrado' };

  const clinica = await hoje.dadosDaClinica(trx, clinicId);

  return {
    ok: true,
    dados: {
      pacienteNome: paciente.name,
      profissionalNome: profissional.name,
      clinicaNome: clinica.nome,
      data: dataDaMensagem(consulta.starts_at, clinica.fuso),
      hora: horaDaMensagem(consulta.starts_at, clinica.fuso),
    },
  };
}
