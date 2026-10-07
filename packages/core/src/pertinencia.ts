import { dataNoFuso } from './expediente';

/**
 * Pertinência: a afirmação do template continua verdadeira na hora do envio?
 *
 * Existe porque retomar não é reexecutar. Quando o WhatsApp da clínica cai, as
 * ações de envio ficam represadas; quando o número volta, a pilha é reclamada de
 * uma vez — e uma ação que fazia sentido às 2h pode não fazer mais às 9h.
 *
 * A regra NÃO é "X minutos de antecedência", e a diferença não é estilo. Cada
 * template AFIRMA algo sobre quando, e só pode sair enquanto essa afirmação for
 * verdade no momento do envio. O caso que prova a forma:
 *
 * - às 23h, uma consulta às 8h de amanhã está a NOVE horas, e "amanhã" é VERDADE;
 * - às 9h, uma consulta às 23h de HOJE está a CATORZE horas, e "amanhã" é FALSO.
 *
 * Qualquer limite em minutos acerta um desses dois casos e erra o outro. É a
 * afirmação que decide, não a distância.
 *
 * O texto dos templates vive na Meta, não aqui — `confirmacao` e `lembrete_final`
 * são enviados sem variáveis. Então a afirmação de cada um é declarada ao lado de
 * `TEMPLATES`, e **trocar o texto na Meta exige revisitar a declaração**. Nenhum
 * teste pega essa divergência; só a regra escrita.
 */

export type AfirmacaoDoTemplate =
  /** "sua consulta de amanhã": vale enquanto a consulta cair num dia posterior ao de hoje. */
  | 'consulta_amanha_ou_depois'
  /** "sua consulta de hoje": vale enquanto for hoje e ainda não tiver começado. */
  | 'consulta_hoje_ainda_por_vir';

export type MotivoSemProposito = 'consulta_no_passado' | 'afirmacao_venceu';

export type Pertinencia = { vale: true } | { vale: false; motivo: MotivoSemProposito };

/**
 * Função pura: quem chama passa o instante e o fuso da clínica. Nenhum
 * `Date.now()` escondido — é isso que permite testar a virada do dia.
 */
export function lerAfirmacao(
  afirmacao: AfirmacaoDoTemplate,
  inicioDaConsulta: Date,
  agora: Date,
  fuso: string,
): Pertinencia {
  // O piso, para qualquer template e sem discussão: consulta que já começou não
  // recebe mensagem sobre estar por vir.
  if (inicioDaConsulta.getTime() <= agora.getTime()) {
    return { vale: false, motivo: 'consulta_no_passado' };
  }

  const diaDaConsulta = dataNoFuso(inicioDaConsulta, fuso);
  const hoje = dataNoFuso(agora, fuso);

  if (afirmacao === 'consulta_amanha_ou_depois') {
    // Dia de CALENDÁRIO, não período de 24 h. Comparação de texto AAAA-MM-DD
    // ordena igual à data, e é o que faz 23h→8h passar e 9h→23h não passar.
    return diaDaConsulta > hoje ? { vale: true } : { vale: false, motivo: 'afirmacao_venceu' };
  }

  // 'consulta_hoje_ainda_por_vir': o lembrete diz hoje. Consulta em outro dia —
  // inclusive amanhã, quando o lembrete cruza a meia-noite — torna o texto falso.
  return diaDaConsulta === hoje ? { vale: true } : { vale: false, motivo: 'afirmacao_venceu' };
}
