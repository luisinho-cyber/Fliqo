/**
 * Como a tela conta a qualidade do número, e por que ela tem dois estados.
 *
 * Esse dado só é acionável fresco. Um "verde" apurado há noventa dias não é
 * informação sobre hoje — é convite a confiar em nada. Então passado o corte, o
 * valor DEIXA de ser mostrado como situação: o ponto fica neutro e a frase diz
 * que não há leitura recente, com a data e a idade em seguida. Uma tela honesta
 * diz "não sei agora" em vez de dizer "verde" com uma ressalva que ninguém lê.
 *
 * O nome verificado não passa por aqui de propósito: nome desatualizado não
 * causa dano nenhum, e ganha data seca. O tratamento segue a consequência de
 * estar errado, não a simetria.
 *
 * Função pura, sem `Date.now()` escondido: quem chama passa o instante.
 */

export type Qualidade = 'verde' | 'amarelo' | 'vermelho' | 'desconhecida';

/** Os tons são os do tokens.css. Nenhuma cor literal sai daqui. */
/**
 * Os tons da nota do número.
 *
 * `atencao` NÃO é âmbar: âmbar significa este minuto ou atraso, e mais nada
 * (DESIGN.md). Nota amarela é alarme, não tempo. Então amarelo e vermelho
 * dividem o matiz `risco` e se separam pela FORMA — anel vazado contra ponto
 * cheio —, que é a mesma regra de em-risco contra faltou na Linha do Dia.
 */
export type TomDaQualidade = 'ok' | 'atencao' | 'risco' | 'neutro';

/** Sete dias: uma semana de operação. Dentro disso, a leitura ainda descreve hoje. */
export const CORTE_DE_FRESCOR_DIAS = 7;

export type LeituraDaQualidade =
  | { estado: 'recente'; rotulo: string; tom: TomDaQualidade; idade: string }
  | { estado: 'antiga'; data: string; idade: string }
  | { estado: 'sem_leitura' };

const ROTULOS: Record<Qualidade, { rotulo: string; tom: TomDaQualidade }> = {
  verde: { rotulo: 'Verde', tom: 'ok' },
  amarelo: { rotulo: 'Amarelo', tom: 'atencao' },
  vermelho: { rotulo: 'Vermelho', tom: 'risco' },
  // A Meta manda isto em número novo. Não é problema, é ausência de nota.
  desconhecida: { rotulo: 'Ainda sem nota', tom: 'neutro' },
};

function partesDoDia(ms: number, fuso: string): { ano: number; mes: number; dia: number } {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const numero = (tipo: string): number =>
    Number(partes.find((p) => p.type === tipo)?.value ?? '0');
  return { ano: numero('year'), mes: numero('month'), dia: numero('day') };
}

/**
 * Dias de calendário no relógio da clínica, não períodos de 24 h.
 *
 * "Apurado ontem" tem que dizer ontem para quem está na clínica, mesmo que
 * tenham passado 30 horas. Contar em 24 h faria a frase discordar do calendário
 * de quem lê.
 */
export function diasDeCalendario(deMs: number, ateMs: number, fuso: string): number {
  const de = partesDoDia(deMs, fuso);
  const ate = partesDoDia(ateMs, fuso);
  const emDias =
    (Date.UTC(ate.ano, ate.mes - 1, ate.dia) - Date.UTC(de.ano, de.mes - 1, de.dia)) / 86_400_000;
  // Apuração no futuro é relógio errado em algum lado, não informação: vale zero.
  return Math.max(0, Math.round(emDias));
}

export function diaEMes(ms: number, fuso: string): string {
  const { mes, dia } = partesDoDia(ms, fuso);
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`;
}

function apuradoHa(dias: number): string {
  if (dias === 0) return 'apurado hoje';
  if (dias === 1) return 'apurado ontem';
  return `apurado há ${String(dias)} dias`;
}

export function lerQualidade(
  qualidade: Qualidade | null,
  apuradaEmIso: string | null,
  agoraMs: number,
  fuso: string,
): LeituraDaQualidade {
  // O banco não deixa um existir sem o outro (0009), mas a tela não depende
  // disso: sem os dois, não há leitura, e ponto.
  if (qualidade === null || apuradaEmIso === null) return { estado: 'sem_leitura' };
  const apuradaEm = Date.parse(apuradaEmIso);
  if (Number.isNaN(apuradaEm)) return { estado: 'sem_leitura' };

  const dias = diasDeCalendario(apuradaEm, agoraMs, fuso);
  if (dias > CORTE_DE_FRESCOR_DIAS) {
    // Passado o corte, o valor não aparece — nem em letra miúda. O que vaza para
    // a tela é o que a pessoa lembra, e "verde" é o que ela lembraria.
    return { estado: 'antiga', data: diaEMes(apuradaEm, fuso), idade: `há ${String(dias)} dias` };
  }
  const { rotulo, tom } = ROTULOS[qualidade];
  return { estado: 'recente', rotulo, tom, idade: apuradoHa(dias) };
}
