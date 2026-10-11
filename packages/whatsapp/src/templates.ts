import { PAYLOAD_BOTOES } from '@fliqo/core';

/**
 * O catálogo de templates: nome na Meta, corpo, parâmetros e botões, num lugar só.
 *
 * Por que o corpo mora aqui e não só no docs/TEMPLATES.md: o corpo é o que determina
 * QUANTAS variáveis o template aprovado tem, e a Meta recusa o envio inteiro quando a
 * contagem difere (erro 132000). Com o corpo no código, a contagem não é declarada por
 * ninguém — ela é CONTADA do texto, e o payload do envio sai da mesma contagem. Não existe
 * ordem para divergir, porque não existe segunda lista.
 *
 * O parâmetro é NOMEADO no código e posicional só na borda. `{{nome_paciente}}` no corpo,
 * `{ nome_paciente: 'Maria' }` na chamada, `{{1}}` só no texto que vai para a Meta e no
 * array que vai no payload. É a troca que elimina a classe de bug mais cara desta parte do
 * sistema: dois parâmetros do mesmo tipo (duas datas, dois nomes) trocados de lugar não dão
 * erro nenhum — a mensagem só fica errada no celular do paciente.
 */

export type IdiomaDeTemplate = 'pt_BR';

/**
 * Categoria da Meta. `UTILITY` é mensagem que o paciente espera por causa de algo que ele
 * fez (marcou consulta, entrou na lista de espera). `MARKETING` exige opt-in registrado e
 * respeita janela por país — e é para onde a Meta reclassifica utility com cara de
 * propaganda. Nenhum template nosso é marketing.
 */
export type CategoriaMeta = 'UTILITY' | 'MARKETING';

export interface BotaoDeRespostaRapida {
  /** O texto que o paciente lê. Tem de ser idêntico ao submetido na Meta. */
  readonly texto: string;
  /**
   * O payload que volta no webhook quando o paciente toca. Não é submetido na Meta: o
   * envio o manda por ÍNDICE, e é `interpretarResposta` do core que o entende na volta.
   */
  readonly payload: string;
}

export interface DefinicaoDeTemplate {
  readonly nome: string;
  readonly categoria: CategoriaMeta;
  readonly idioma: IdiomaDeTemplate;
  /**
   * Os parâmetros, na ordem em que viram `{{1}}`, `{{2}}`… Declarado para o TypeScript
   * saber os nomes; conferido contra o corpo por teste, porque declaração e corpo são duas
   * coisas que podem divergir e o teste é o que impede.
   */
  readonly parametros: readonly string[];
  /** O corpo com os parâmetros nomeados entre chaves duplas. */
  readonly corpo: string;
  /**
   * Um valor de exemplo por parâmetro. A Meta EXIGE `example.body_text` para aprovar
   * template com variável — sem isso a submissão é recusada antes de chegar ao revisor —,
   * então isto não é dado de exemplo nosso: é campo obrigatório da API de registro. Valores
   * genéricos de propósito: nada aqui pode parecer paciente, profissional ou clínica real.
   */
  readonly exemplos: Readonly<Record<string, string>>;
  readonly botoes: readonly BotaoDeRespostaRapida[];
}

const BOTAO = {
  REMARCAR: { texto: 'Preciso remarcar', payload: PAYLOAD_BOTOES.REMARCAR },
  CANCELAR: { texto: 'Não vou poder ir', payload: PAYLOAD_BOTOES.CANCELAR },
  CIENTE_DO_ATRASO: { texto: 'Tudo bem, eu vou', payload: PAYLOAD_BOTOES.CIENTE_DO_ATRASO },
  CONFIRMAR_PRESENCA: { texto: 'Confirmar presença', payload: PAYLOAD_BOTOES.CONFIRMAR },
  QUERO_ESTE_HORARIO: { texto: 'Quero este horário', payload: PAYLOAD_BOTOES.QUERO_VAGA },
} as const satisfies Record<string, BotaoDeRespostaRapida>;

/**
 * Os templates, por chave de código. CINCO, e são os cinco nomes que já existem.
 *
 * Nome novo na Meta não é de graça: cada template conta contra o limite da conta, e um
 * conjunto novo ao lado do antigo deixa metade órfã — aprovada, consumindo cota, e sem
 * código que a envie. Então o que mudou foi o CORPO de dois deles, não o nome de nenhum.
 *
 * A consequência disso tem data marcada e está no fim do docs/TEMPLATES.md: com o mesmo
 * nome, código e Meta mudam JUNTOS. Não existe janela em que o corpo novo esteja aprovado
 * e o código antigo ainda funcione — submeter primeiro, esperar a aprovação, mesclar depois.
 */
export const TEMPLATES_META = {
  /**
   * Primeiro pedido de confirmação, `confirm_hours_before` antes da consulta (2 a 72 h,
   * migração 0001).
   *
   * `data` e `hora` são duas variáveis, não uma. A Meta recusa duas variáveis coladas sem
   * texto entre elas, e o "às" que as separa é texto aprovado — não concatenação nossa. O
   * corpo também não pode TERMINAR em variável, e é por isso que a linha da clínica fecha
   * com uma frase, não com `{{nome_clinica}}`.
   *
   * O corpo não diz "amanhã": com 72 h de antecedência seria mentira. Quem diz o dia é
   * `{{data}}`.
   */
  confirmacao: {
    nome: 'confirmacao_consulta',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['nome_paciente', 'nome_profissional', 'data', 'hora', 'nome_clinica'],
    corpo:
      'Olá, {{nome_paciente}}. Sua consulta com {{nome_profissional}} está marcada para {{data}}, às {{hora}}.\n' +
      '\n' +
      'Você confirma que vai poder vir? Se precisar de outro horário, a gente remarca por aqui.\n' +
      '\n' +
      'Mensagem da clínica {{nome_clinica}}. Pode responder nesta conversa.',
    exemplos: {
      nome_paciente: 'Maria',
      nome_profissional: 'Dra. Helena',
      data: 'terça, 14/10',
      hora: '14:30',
      nome_clinica: 'Clínica Modelo',
    },
    /**
     * Três botões, e o terceiro é o que importa: `Não vou poder ir` é o ÚNICO toque que
     * libera o horário e dispara a lista de espera (`liberar_horario_e_ofertar`). Tirá-lo
     * obrigaria quem não pode vir a escrever, e a vaga só abriria depois de a IA
     * interpretar o texto.
     */
    botoes: [BOTAO.CONFIRMAR_PRESENCA, BOTAO.REMARCAR, BOTAO.CANCELAR],
  },

  /** Lembrete do mesmo dia, `final_reminder_minutes` antes (30 a 240 min, migração 0001). */
  lembreteFinal: {
    nome: 'lembrete_final',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: [],
    corpo:
      'Passando para lembrar da sua consulta de hoje aqui na clínica.\n' +
      '\n' +
      'Se precisar avisar qualquer coisa, pode responder nesta conversa.',
    exemplos: {},
    botoes: [],
  },

  /**
   * Oferta de vaga para quem está na lista de espera.
   *
   * `data` e `hora` são o que faltava: a versão sem variável dizia "abriu um horário" e dava
   * um botão que MARCA a consulta, sem o paciente saber se era terça às 8h ou sexta às 19h.
   */
  ofertaDeVaga: {
    nome: 'oferta_de_vaga',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['nome_paciente', 'data', 'hora', 'nome_clinica'],
    corpo:
      'Olá, {{nome_paciente}}. Abriu um horário na nossa agenda: {{data}}, às {{hora}}.\n' +
      '\n' +
      'Você está na lista de espera para este atendimento. Quem responder primeiro fica com o horário; se não der para você, não precisa fazer nada.\n' +
      '\n' +
      'Mensagem da clínica {{nome_clinica}}. Pode responder nesta conversa.',
    exemplos: {
      nome_paciente: 'Maria',
      data: 'quinta, 16/10',
      hora: '09:00',
      nome_clinica: 'Clínica Modelo',
    },
    botoes: [BOTAO.QUERO_ESTE_HORARIO],
  },

  /**
   * Aviso de atraso. "Preciso remarcar" reusa o payload de remarcação: o atraso é da
   * clínica, e quem remarca por causa dele não cancelou — o fluxo de remarcação não cobra
   * taxa de cancelamento.
   *
   * Sem `data`: o aviso é sempre do dia corrente, e dizer a data de hoje numa mensagem que
   * chega hoje é ruído. `novo_horario` é hora, não data e hora colados.
   */
  avisoDeAtraso: {
    nome: 'aviso_de_atraso',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['minutos_de_atraso', 'novo_horario'],
    corpo:
      'Precisamos avisar de um atraso aqui na clínica, de cerca de {{minutos_de_atraso}} minutos.\n' +
      '\n' +
      'A previsão agora é atender você às {{novo_horario}}. Se preferir outro dia, me diga por aqui.',
    exemplos: { minutos_de_atraso: '25', novo_horario: '14:55' },
    botoes: [BOTAO.CIENTE_DO_ATRASO, BOTAO.REMARCAR],
  },

  /** O atraso passou: o horário marcado volta a valer, e é ele que a mensagem repete. */
  atrasoNormalizou: {
    nome: 'atraso_normalizou',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['horario_original'],
    corpo:
      'O atraso aqui na clínica já foi resolvido.\n' +
      '\n' +
      'Seu horário das {{horario_original}} continua valendo como estava combinado. Se precisar falar com a gente, responda nesta conversa.',
    exemplos: { horario_original: '14:30' },
    botoes: [],
  },
} as const satisfies Record<string, DefinicaoDeTemplate>;

export type ChaveDeTemplate = keyof typeof TEMPLATES_META;

/** O nome como a Meta o conhece. É por ele que o envio acha o template. */
export type NomeDeTemplate = (typeof TEMPLATES_META)[ChaveDeTemplate]['nome'];

/**
 * Os parâmetros de um template, nomeados e obrigatórios.
 *
 * `Record<never, string>` para template sem parâmetro: quem chamar passando objeto cheio
 * não compila, o que é o ponto.
 */
export type ParametrosDe<C extends ChaveDeTemplate> = Record<
  (typeof TEMPLATES_META)[C]['parametros'][number],
  string
>;

const TODOS = Object.values(TEMPLATES_META) as readonly DefinicaoDeTemplate[];

/** A definição, pelo nome que vai para a Meta. `undefined` para nome que não existe. */
export function definicaoPorNome(nome: string): DefinicaoDeTemplate | undefined {
  return TODOS.find((t) => t.nome === nome);
}

export function todasAsDefinicoes(): readonly DefinicaoDeTemplate[] {
  return TODOS;
}

/**
 * Os nomes de parâmetro do corpo, na ordem em que aparecem.
 *
 * Primeira aparição conta: um parâmetro repetido no corpo seria um `{{n}}` repetido na
 * Meta, que a Meta não aceita — `conferirCorpo` recusa isso antes de qualquer envio.
 */
export function parametrosDoCorpo(corpo: string): string[] {
  const ordem: string[] = [];
  for (const achado of corpo.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    const nome = achado[1];
    if (nome !== undefined && !ordem.includes(nome)) ordem.push(nome);
  }
  return ordem;
}

/** O corpo como a Meta o quer: `{{nome_paciente}}` vira `{{1}}`, na ordem de aparição. */
export function corpoParaMeta(def: DefinicaoDeTemplate): string {
  const ordem = parametrosDoCorpo(def.corpo);
  return def.corpo.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (inteiro, nome: string) => {
    const indice = ordem.indexOf(nome);
    return indice === -1 ? inteiro : `{{${String(indice + 1)}}}`;
  });
}

export type ProblemaDoCorpo =
  | 'parametro_abre_o_corpo'
  | 'parametro_fecha_o_corpo'
  | 'parametros_colados'
  | 'parametro_repetido'
  | 'parametro_declarado_fora_do_corpo'
  | 'parametro_do_corpo_nao_declarado'
  | 'ordem_divergente'
  | 'termo_proibido'
  | 'exemplo_ausente'
  | 'exemplo_sobrando';

/**
 * Termos que fazem a Meta reclassificar utility como marketing, mais o jargão que paciente
 * não fala. "no-show" é proibido por decisão nossa: a palavra em português é "falta".
 */
const TERMOS_PROIBIDOS = [
  'no-show',
  'no show',
  'noshow',
  'clique aqui',
  'promoção',
  'promocao',
  'imperdível',
  'imperdivel',
  'não perca',
  'nao perca',
  'desconto',
  'oferta especial',
  'aproveite',
  'última chance',
  'ultima chance',
] as const;

/**
 * Confere uma definição contra as regras da Meta e as nossas, antes de registrar ou enviar.
 *
 * Existe porque cada uma destas falhas só aparece com a clínica real esperando: a Meta
 * recusa na submissão (parâmetro na borda do corpo) ou no envio (contagem), e reclassificar
 * para marketing muda quando a mensagem pode sair. Nenhuma delas é visível lendo o texto.
 */
export function conferirCorpo(def: DefinicaoDeTemplate): ProblemaDoCorpo[] {
  const problemas: ProblemaDoCorpo[] = [];
  const corpo = def.corpo.trim();

  if (/^\{\{/.test(corpo)) problemas.push('parametro_abre_o_corpo');
  if (/\}\}$/.test(corpo)) problemas.push('parametro_fecha_o_corpo');

  /*
   * Duas variáveis sem texto entre elas, a Meta recusa na submissão. É a regra que fez
   * `data_hora` virar `{{data}}, às {{hora}}`: colar as duas produziria `{{1}}{{2}}`, que
   * nem chega ao revisor. O espaço sozinho conta como colado — tem de haver texto.
   */
  if (/\}\}\s*\{\{/.test(def.corpo)) problemas.push('parametros_colados');

  const todasAsOcorrencias = [...def.corpo.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)].map(
    (a) => a[1],
  );
  const noCorpo = parametrosDoCorpo(def.corpo);
  if (todasAsOcorrencias.length !== noCorpo.length) problemas.push('parametro_repetido');

  for (const declarado of def.parametros) {
    if (!noCorpo.includes(declarado)) problemas.push('parametro_declarado_fora_do_corpo');
  }
  for (const usado of noCorpo) {
    if (!def.parametros.includes(usado)) problemas.push('parametro_do_corpo_nao_declarado');
  }
  if (
    noCorpo.length === def.parametros.length &&
    noCorpo.some((nome, i) => nome !== def.parametros[i])
  ) {
    problemas.push('ordem_divergente');
  }

  for (const nome of noCorpo) {
    const exemplo = def.exemplos[nome];
    if (exemplo === undefined || exemplo.trim() === '') problemas.push('exemplo_ausente');
  }
  for (const nome of Object.keys(def.exemplos)) {
    if (!noCorpo.includes(nome)) problemas.push('exemplo_sobrando');
  }

  const minusculo = def.corpo.toLowerCase();
  if (TERMOS_PROIBIDOS.some((termo) => minusculo.includes(termo))) {
    problemas.push('termo_proibido');
  }

  return problemas;
}

export { TERMOS_PROIBIDOS };

/**
 * Os valores dos parâmetros na ordem posicional, a partir do objeto nomeado.
 *
 * Recusa em vez de preencher: parâmetro vazio é `{{1}}` chegando como string vazia no
 * celular do paciente — "Sua consulta com  está marcada para " —, e a Meta aceita isso sem
 * reclamar. É o erro que só o paciente vê.
 */
export type ValoresDoCorpo =
  | { ok: true; valores: string[] }
  | { ok: false; motivo: 'parametro_ausente' | 'parametro_vazio'; parametro: string };

export function valoresDoCorpo(
  def: DefinicaoDeTemplate,
  params: Readonly<Record<string, string>>,
): ValoresDoCorpo {
  const valores: string[] = [];
  for (const nome of parametrosDoCorpo(def.corpo)) {
    const valor = params[nome];
    if (valor === undefined) return { ok: false, motivo: 'parametro_ausente', parametro: nome };
    if (valor.trim() === '') return { ok: false, motivo: 'parametro_vazio', parametro: nome };
    valores.push(valor);
  }
  return { ok: true, valores };
}

/**
 * Os `components` como a API de registro da Meta os quer.
 *
 * Sai da MESMA definição que o envio usa: o corpo com `{{1}}` vem de `corpoParaMeta`, a
 * ordem dos exemplos vem da ordem de aparição no corpo, e o texto dos botões vem do mesmo
 * array cujos payloads o envio manda por índice. É isso que garante que o template
 * aprovado e o template enviado sejam o mesmo template — a divergência entre os dois é a
 * falha mais cara desta parte do sistema, porque ela não quebra teste nenhum.
 */
export function componentesParaRegistro(def: DefinicaoDeTemplate): unknown[] {
  const ordem = parametrosDoCorpo(def.corpo);
  const corpo: Record<string, unknown> = { type: 'BODY', text: corpoParaMeta(def) };
  if (ordem.length > 0) {
    corpo['example'] = { body_text: [ordem.map((nome) => def.exemplos[nome] ?? nome)] };
  }

  const componentes: unknown[] = [corpo];
  if (def.botoes.length > 0) {
    componentes.push({
      type: 'BUTTONS',
      buttons: def.botoes.map((b) => ({ type: 'QUICK_REPLY', text: b.texto })),
    });
  }
  return componentes;
}

/** O corpo do POST de registro, sem credencial nenhuma: quem põe o token é quem chama. */
export function corpoDoRegistro(def: DefinicaoDeTemplate): Record<string, unknown> {
  return {
    name: def.nome,
    language: def.idioma,
    category: def.categoria,
    components: componentesParaRegistro(def),
  };
}
