/**
 * Pontualidade: o que foi planejado contra o que aconteceu.
 *
 * Duas leituras da mesma coisa. A primeira é o desfecho — quantos atendimentos
 * começaram na hora e quanto atrasaram em média. A segunda é a CAUSA: a duração
 * cadastrada do procedimento contra a duração que ele tem de verdade.
 *
 * A ordem importa para quem lê a tela. Atraso médio é sintoma, e sintoma não se
 * conserta: ninguém "decide" chegar no horário. Duração cadastrada errada é
 * conserto de uma linha no cadastro, e é ela que produz o sintoma todo dia.
 *
 * A REGRA da sugestão mora aqui, e `atrasos.sugerirDuracao` é uma porta para
 * ela. São duas portas porque as duas fontes de medida são diferentes: a demo
 * tem o array cru das durações, e o painel tem a mediana que o Postgres já
 * calculou na view. A regra em si não pode ser duas.
 */

/**
 * Quantos minutos de atraso a clínica considera "no horário".
 *
 * Não é um número escolhido aqui: é o que a view `professional_punctuality`
 * (migração 0002) já usa para contar `on_time`, e está declarado neste lado para
 * que a conta da tela e a conta do banco não digam coisas diferentes. Há teste em
 * packages/db que planta um atendimento exatamente neste limite e outro um minuto
 * além — mexer na view sem mexer aqui quebra alto.
 */
export const TOLERANCIA_PONTUALIDADE_MIN = 10;

/**
 * Amostra mínima para acreditar na mediana medida.
 *
 * O mesmo número que `duracaoParaProjecao` usa para decidir se a Linha do Dia
 * confia na duração medida ou fica com a cadastrada — e é o mesmo de propósito.
 * Sugerir ao dono um ajuste com base numa amostra em que a própria tela ainda não
 * confia seria a Fliqo se contradizendo em duas telas.
 *
 * Oito é pouco para estatística e muito para clínica pequena: é o ponto em que um
 * procedimento de rotina já foi feito o suficiente para a mediana não ser um caso
 * excepcional, sem que uma clínica nova espere um trimestre para ver sugestão.
 */
export const AMOSTRA_MINIMA = 8;

/**
 * A partir de quantos minutos de divergência vale mexer no cadastro.
 *
 * Derivado da tolerância, e não escolhido à parte: dez minutos de divergência são
 * exatamente o bastante para empurrar o paciente seguinte para fora do "no
 * horário". Abaixo disso o cadastro está errado mas não é o que está atrasando a
 * clínica, e sugestão que a recepção aprende a ignorar não é sugestão.
 *
 * Vale para os dois lados. Procedimento que dura MENOS do que o cadastrado é
 * horário vago que a clínica está jogando fora, e isso é dinheiro do mesmo jeito.
 */
export const LIMIAR_DE_DIVERGENCIA_MIN = TOLERANCIA_PONTUALIDADE_MIN;

/**
 * A agenda da clínica é desenhada em marcas de cinco minutos, então a sugestão
 * também. E arredonda para CIMA: reservar 55 onde a mediana é 52 custa três
 * minutos de folga, e reservar 50 custa o atraso de todos os pacientes seguintes.
 */
export const GRADE_DA_AGENDA_MIN = 5;

export interface OpcoesDeSugestao {
  amostraMinima: number;
  diferencaMinimaMin: number;
  arredondarPara: number;
}

export const SUGESTAO_PADRAO: OpcoesDeSugestao = {
  amostraMinima: AMOSTRA_MINIMA,
  diferencaMinimaMin: LIMIAR_DE_DIVERGENCIA_MIN,
  arredondarPara: GRADE_DA_AGENDA_MIN,
};

export type MotivoSemSugestao = 'amostra_pequena' | 'divergencia_pequena';

export type SugestaoDeDuracao =
  | { sugerir: false; motivo: MotivoSemSugestao }
  | {
      sugerir: true;
      /** O que está no cadastro hoje. */
      cadastradaMin: number;
      /** O que vai para o cadastro se alguém aceitar. */
      novaDuracaoMin: number;
      /** A mediana medida, sem arredondar: é o dado, e a tela mostra o dado. */
      medianaMin: number;
      amostra: number;
    };

/**
 * A regra, e é ela que o botão da tela obedece.
 *
 * Quem aceita a sugestão NÃO manda o número novo: a API recalcula esta função e
 * grava o que ela devolver. Assim o "um toque" não é uma porta para escrever
 * qualquer duração no cadastro — o valor gravado é o que o servidor mediu.
 */
export function sugerirDuracaoPelaMediana(
  medida: { medianaMin: number; amostra: number },
  cadastradaMin: number,
  opcoes: OpcoesDeSugestao = SUGESTAO_PADRAO,
): SugestaoDeDuracao {
  if (medida.amostra < opcoes.amostraMinima) return { sugerir: false, motivo: 'amostra_pequena' };
  if (Math.abs(medida.medianaMin - cadastradaMin) < opcoes.diferencaMinimaMin) {
    return { sugerir: false, motivo: 'divergencia_pequena' };
  }
  return {
    sugerir: true,
    cadastradaMin,
    novaDuracaoMin: Math.ceil(medida.medianaMin / opcoes.arredondarPara) * opcoes.arredondarPara,
    medianaMin: medida.medianaMin,
    amostra: medida.amostra,
  };
}

/** Mediana de uma amostra crua. Mediana e não média: um atendimento que travou não desloca a conta. */
export function medianaDe(valores: readonly number[]): number | undefined {
  if (valores.length === 0) return undefined;
  const ord = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  const acima = ord[meio];
  const abaixo = ord[meio - 1];
  if (acima === undefined) return undefined;
  return ord.length % 2 === 1 ? acima : ((abaixo ?? acima) + acima) / 2;
}

/**
 * Percentual no horário, inteiro.
 *
 * Inteiro porque "87,3% no horário" finge uma precisão que trinta atendimentos
 * não têm. Sem atendimento nenhum devolve `null`, e não 0% — profissional que não
 * atendeu no período não é profissional que atrasou em tudo, e a tela tem de
 * poder dizer "sem atendimento" em vez de acusar.
 */
export function percentualNoHorario(p: { atendimentos: number; noHorario: number }): number | null {
  if (p.atendimentos <= 0) return null;
  return Math.round((p.noHorario / p.atendimentos) * 100);
}
