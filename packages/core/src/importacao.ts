/**
 * Modo convidado: ler a agenda que a clínica já mantém em outro sistema.
 *
 * O que entra aqui é só o que é PURO: separar a planilha em campos, aplicar o
 * mapeamento de colunas que a clínica escolheu na tela, e dizer se cada linha
 * serve. Quem acha paciente, cria consulta e lida com horário ocupado é o
 * repositório — porque isso depende do banco, e porque conflito de agenda é
 * decidido pelo banco (CLAUDE.md, regra 3).
 *
 * Nenhum formato fixo, de propósito: cada sistema exporta de um jeito, e exigir
 * um cabeçalho nosso seria pedir à clínica que editasse a planilha antes de nos
 * entregar — que é exatamente o atrito que o modo convidado existe para evitar.
 */

/**
 * O que a flag `guest_mode` desliga.
 *
 * Lista enumerada, no formato das outras do projeto (`SEM_FORCE`,
 * `ACOES_QUE_ENVIAM`), e não uma condição espalhada por tela: recurso novo tem de
 * passar por aqui para alguém decidir se ele faz sentido quando a verdade está em
 * outro sistema. Há teste exigindo prontuário e financeiro nesta lista.
 *
 * Prontuário e caixa PARCIAIS são pior do que ausentes: um número que não fecha com
 * o outro sistema faz a clínica desconfiar dos números que estão certos — e aí a
 * agenda, que é o que funciona, perde crédito junto.
 */
export const RECURSOS_DO_MODO_PROPRIO = ['prontuario', 'financeiro'] as const;
export type RecursoDoModoProprio = (typeof RECURSOS_DO_MODO_PROPRIO)[number];

/**
 * A agenda, a confirmação, a lista de espera, o atraso e o atendente continuam
 * valendo em qualquer modo: é isso que a Fliqo faz sobre a agenda de outro sistema.
 */
export function recursoLiberado(
  recurso: RecursoDoModoProprio,
  clinica: { modoConvidado: boolean },
): boolean {
  return !clinica.modoConvidado || !RECURSOS_DO_MODO_PROPRIO.includes(recurso);
}

/**
 * Teto de linhas por importação.
 *
 * Não é performance: é o limite de corpo da nossa API (2 MB) encontrado de frente,
 * com a recusa escrita em português em vez de um 413 cru. Duas mil linhas são mais
 * de um mês de agenda de uma clínica com quatro profissionais; quem precisa de mais
 * manda em dois arquivos, e a reimportação é idempotente justamente para que isso
 * não dê medo.
 */
export const MAXIMO_DE_LINHAS = 2000;

/** Os separadores que os sistemas brasileiros produzem. `;` é o que o Excel pt-BR exporta. */
const SEPARADORES = [';', ',', '\t'] as const;

/**
 * Separa um texto delimitado em linhas de campos.
 *
 * Escrito à mão, e não com biblioteca, porque o que precisamos é pequeno e
 * fechado: campo entre aspas, aspas duplicada dentro do campo, e fim de linha
 * dentro de campo com aspas. Uma dependência nova para isso custaria mais em
 * revisão de licença e atualização do que as quarenta linhas abaixo.
 */
export function separarCampos(texto: string, separador: string): string[][] {
  const linhas: string[][] = [];
  let campos: string[] = [];
  let atual = '';
  let dentroDeAspas = false;

  // Remove o BOM que o Excel põe no começo do arquivo: sem isso a primeira
  // coluna do cabeçalho vem com um caractere invisível e nunca casa com nada.
  const limpo = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;

  const fecharCampo = () => {
    campos.push(atual.trim());
    atual = '';
  };
  const fecharLinha = () => {
    fecharCampo();
    // Linha inteiramente vazia não é linha: planilha costuma terminar com várias.
    if (campos.some((c) => c !== '')) linhas.push(campos);
    campos = [];
  };

  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (dentroDeAspas) {
      if (c === '"') {
        // Aspas duplicada é uma aspas literal; uma só fecha o campo.
        if (limpo[i + 1] === '"') {
          atual += '"';
          i++;
        } else dentroDeAspas = false;
      } else atual += c ?? '';
      continue;
    }
    if (c === '"' && atual === '') {
      dentroDeAspas = true;
      continue;
    }
    if (c === separador) {
      fecharCampo();
      continue;
    }
    if (c === '\n') {
      fecharLinha();
      continue;
    }
    if (c === '\r') continue;
    atual += c ?? '';
  }
  if (atual !== '' || campos.length > 0) fecharLinha();

  return linhas;
}

/**
 * Qual separador o arquivo usa.
 *
 * Decide pelo CABEÇALHO, e pelo que produz mais colunas: uma planilha separada por
 * ponto e vírgula costuma ter vírgula dentro de nome ("Silva, Maria"), então contar
 * o arquivo inteiro erra. O empate fica com a ordem de SEPARADORES, que põe `;` na
 * frente porque é o que o Excel em português exporta.
 */
export function descobrirSeparador(texto: string): string {
  const primeira = texto.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  let melhor: string = SEPARADORES[0];
  let colunas = 0;
  for (const s of SEPARADORES) {
    const n = separarCampos(primeira, s)[0]?.length ?? 0;
    if (n > colunas) {
      colunas = n;
      melhor = s;
    }
  }
  return melhor;
}

/** O que a clínica escolheu na tela: qual coluna é o quê. Índice na linha, começando em 0. */
export interface MapaDeColunas {
  paciente: number;
  telefone: number;
  profissional: number;
  inicio: number;
  procedimento: number;
}

export type CampoMapeado = keyof MapaDeColunas;

export const CAMPOS_OBRIGATORIOS: readonly CampoMapeado[] = [
  'paciente',
  'telefone',
  'profissional',
  'inicio',
  'procedimento',
];

/**
 * Palpite do mapeamento, a partir do cabeçalho.
 *
 * É palpite: a tela mostra o que ele achou e a clínica corrige. Adivinhar e
 * importar sem mostrar seria rápido uma vez e errado para sempre no sistema cujo
 * cabeçalho a gente não previu.
 */
const PISTAS: Record<CampoMapeado, string[]> = {
  paciente: ['paciente', 'nome', 'cliente'],
  telefone: ['telefone', 'celular', 'fone', 'whatsapp', 'contato'],
  profissional: [
    'profissional',
    'dentista',
    'medico',
    'médico',
    'doutor',
    'responsavel',
    'responsável',
  ],
  inicio: ['inicio', 'início', 'data', 'horario', 'horário', 'hora', 'agendamento'],
  procedimento: ['procedimento', 'servico', 'serviço', 'tratamento', 'especialidade'],
};

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function adivinharMapa(cabecalho: readonly string[]): Partial<MapaDeColunas> {
  const normalizado = cabecalho.map(semAcento);
  const mapa: Partial<MapaDeColunas> = {};
  const usados = new Set<number>();

  for (const campo of CAMPOS_OBRIGATORIOS) {
    const pistas = PISTAS[campo].map(semAcento);
    // Coluna já atribuída não é reaproveitada: "data" e "hora" na mesma planilha
    // não podem virar as duas o campo de início.
    const i = normalizado.findIndex(
      (titulo, idx) => !usados.has(idx) && pistas.some((p) => titulo.includes(p)),
    );
    if (i >= 0) {
      mapa[campo] = i;
      usados.add(i);
    }
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Uma linha
// ---------------------------------------------------------------------------

/**
 * Por que uma linha foi recusada. Lista fechada: motivo novo entra aqui, e a tela
 * tem de escrever a frase dele — motivo sem frase vira "erro desconhecido", que não
 * ajuda ninguém a consertar a planilha.
 *
 * `horario_ocupado` é o único que não nasce aqui: ele vem do banco, que é quem
 * decide conflito de agenda.
 */
export const MOTIVOS_DE_RECUSA = [
  'colunas_de_menos',
  'sem_paciente',
  'telefone_invalido',
  'sem_profissional',
  'data_invalida',
  'sem_procedimento',
  'horario_ocupado',
] as const;
export type MotivoDeRecusa = (typeof MOTIVOS_DE_RECUSA)[number];

export interface LinhaDaAgenda {
  paciente: string;
  telefone: string;
  profissional: string;
  procedimento: string;
  /**
   * Instante LOCAL da clínica, como `AAAA-MM-DD HH:MM`, sem fuso.
   *
   * De propósito: "14:00" numa planilha é 14h na clínica, e converter aqui exigiria
   * saber o fuso e as regras de horário de verão dele. Quem converte é o Postgres,
   * no insert, com `at time zone` e o fuso que a clínica já tem cadastrado — é
   * exato, não precisa de biblioteca, e mantém este módulo puro.
   */
  inicioLocal: string;
}

export type LeituraDaLinha =
  { ok: true; linha: LinhaDaAgenda } | { ok: false; motivo: MotivoDeRecusa; rotulo: string };

const DATA_HORA_BR = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2}))?/;
const DATA_HORA_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{1,2}):(\d{2}))?/;

function doisDigitos(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

/**
 * Data e hora da planilha para `AAAA-MM-DD HH:MM`.
 *
 * Aceita dd/mm/aaaa (o que todo sistema brasileiro exporta) e aaaa-mm-dd. Ano de
 * dois dígitos vira 20xx: planilha de agenda é do presente, e 1925 não é uma
 * leitura plausível de "25".
 *
 * Sem hora, a linha é recusada em vez de assumir meia-noite: consulta à meia-noite
 * é mentira que entraria na agenda sem ninguém notar.
 */
export function lerDataHora(bruto: string): string | undefined {
  const texto = bruto.trim();
  const iso = DATA_HORA_ISO.exec(texto);
  const br = iso === null ? DATA_HORA_BR.exec(texto) : null;

  let ano: number;
  let mes: number;
  let dia: number;
  let hora: string | undefined;
  let minuto: string | undefined;

  if (iso !== null) {
    [ano, mes, dia] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    [hora, minuto] = [iso[4], iso[5]];
  } else if (br !== null) {
    [dia, mes] = [Number(br[1]), Number(br[2])];
    const anoBruto = Number(br[3]);
    ano = anoBruto < 100 ? 2000 + anoBruto : anoBruto;
    [hora, minuto] = [br[4], br[5]];
  } else return undefined;

  if (hora === undefined || minuto === undefined) return undefined;
  const h = Number(hora);
  const m = Number(minuto);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || h > 23 || m > 59) return undefined;
  // Dia que não existe no mês (31/02) é recusado pela construção da data.
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return undefined;

  return `${String(ano)}-${doisDigitos(mes)}-${doisDigitos(dia)} ${doisDigitos(h)}:${doisDigitos(m)}`;
}

/** Rótulo curto para o relatório: o nome como veio, cortado no tamanho da coluna. */
export function rotuloDaLinha(campos: readonly string[], mapa: MapaDeColunas): string {
  return (campos[mapa.paciente] ?? '').slice(0, 120);
}

/**
 * Uma linha da planilha, já mapeada. A validação do telefone NÃO acontece aqui:
 * quem sabe normalizar é `normalizarTelefoneBR`, e quem decide se o paciente existe
 * é o repositório. Aqui só se recusa o que está vazio ou ilegível.
 */
export function lerLinha(campos: readonly string[], mapa: MapaDeColunas): LeituraDaLinha {
  const rotulo = rotuloDaLinha(campos, mapa);
  // Os campos um a um, e não `Object.values`: o mapa é uma interface, e values()
  // devolve `any[]` — o lint perde a conferência e um campo novo passaria sem tipo.
  const maiorIndice = Math.max(
    mapa.paciente,
    mapa.telefone,
    mapa.profissional,
    mapa.inicio,
    mapa.procedimento,
  );
  if (campos.length <= maiorIndice) {
    return { ok: false, motivo: 'colunas_de_menos', rotulo };
  }

  const pegar = (i: number): string => (campos[i] ?? '').trim();
  const paciente = pegar(mapa.paciente);
  const telefone = pegar(mapa.telefone);
  const profissional = pegar(mapa.profissional);
  const procedimento = pegar(mapa.procedimento);

  if (paciente === '') return { ok: false, motivo: 'sem_paciente', rotulo };
  if (telefone === '') return { ok: false, motivo: 'telefone_invalido', rotulo };
  if (profissional === '') return { ok: false, motivo: 'sem_profissional', rotulo };
  if (procedimento === '') return { ok: false, motivo: 'sem_procedimento', rotulo };

  const inicioLocal = lerDataHora(pegar(mapa.inicio));
  if (inicioLocal === undefined) return { ok: false, motivo: 'data_invalida', rotulo };

  return { ok: true, linha: { paciente, telefone, profissional, procedimento, inicioLocal } };
}
