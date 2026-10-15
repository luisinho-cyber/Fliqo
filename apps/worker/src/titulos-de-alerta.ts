import type { AcaoPendente } from './acoes';

/**
 * Os títulos dos alertas de ação, em linguagem de gente.
 *
 * O título é o que a recepção lê na tela Hoje. Antes ele levava o nome interno da ação
 * (`Não sei se "confirmacao" chegou ao paciente`) e nenhuma pista de QUEM nem QUANDO —
 * a recepção tinha de adivinhar qual das consultas de amanhã era. Agora diz o paciente e
 * o horário, no fuso da clínica.
 */

export interface ConsultaDoAlerta {
  paciente: string;
  inicio: Date;
  fuso: string;
}

type Tipo = AcaoPendente['kind'];

/** O que a ação é, dito para quem não sabe que existe uma tabela de ações. */
const MENSAGEM: Record<Tipo, string> = {
  confirmacao: 'a confirmação',
  lembrete_final: 'o lembrete',
  marcar_risco: 'a marcação de consulta em risco',
  expirar_oferta: 'o encerramento da oferta de vaga',
};

/** "15/10 às 14:30", no fuso da clínica: é o horário que a recepção tem na agenda. */
export function quandoDaConsulta(inicio: Date, fuso: string): string {
  const dia = inicio.toLocaleDateString('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
  });
  const hora = inicio.toLocaleTimeString('pt-BR', {
    timeZone: fuso,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${dia} às ${hora}`;
}

function deQuem(c: ConsultaDoAlerta): string {
  return `${c.paciente} — consulta ${quandoDaConsulta(c.inicio, c.fuso)}`;
}

/** A mensagem pode ter saído ou não. */
export function tituloDeEnvioIncerto(tipo: Tipo, c: ConsultaDoAlerta | undefined): string {
  return c === undefined
    ? `Não sei se ${MENSAGEM[tipo]} chegou ao paciente`
    : `Não sei se ${MENSAGEM[tipo]} chegou para ${deQuem(c)}`;
}

/** A ação desistiu de vez. */
export function tituloDeFalha(tipo: Tipo, c: ConsultaDoAlerta | undefined): string {
  if (tipo === 'marcar_risco') {
    return c === undefined
      ? 'Não consegui marcar a consulta como em risco'
      : `Não consegui marcar em risco a consulta de ${deQuem(c)}`;
  }
  if (tipo === 'expirar_oferta') return 'Não consegui encerrar a oferta de vaga';
  return c === undefined
    ? `Não consegui enviar ${MENSAGEM[tipo]}`
    : `Não consegui enviar ${MENSAGEM[tipo]} para ${deQuem(c)}`;
}
