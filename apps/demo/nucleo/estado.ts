import {
  CONFIRMACOES,
  CONSULTAS,
  LISTA_DE_ESPERA,
  PROCEDIMENTOS,
  type ConfirmacaoDemo,
  type ConsultaDemo,
  type EsperaDemo,
} from './dados';

export type Aba = 'dia' | 'confirmacao' | 'espera';

export interface Mensagem {
  de: 'clinica' | 'paciente';
  texto: string;
  quando: string;
}

/** Um botão do template da Meta, do lado do paciente. */
export interface BotaoDoTemplate {
  rotulo: string;
  payload: string;
}

export interface Conversa {
  consultaId: string;
  paciente: string;
  mensagens: Mensagem[];
  botoes: BotaoDoTemplate[];
}

export interface Oferta {
  consultaId: string;
  expiraEm: Date;
  quantos: number;
}

export interface Estado {
  aba: Aba;
  consultas: ConsultaDemo[];
  confirmacoes: ConfirmacaoDemo[];
  fila: EsperaDemo[];
  conversas: Record<string, Conversa>;
  conversaAtiva: string;
  selecionada: string | null;
  oferta: Oferta | null;
}

export function estadoInicial(): Estado {
  return {
    aba: 'dia',
    consultas: CONSULTAS.map((c) => ({ ...c })),
    confirmacoes: CONFIRMACOES.map((c) => ({ ...c })),
    fila: LISTA_DE_ESPERA.map((w) => ({ ...w })),
    conversas: conversasIniciais(),
    conversaAtiva: 'a7',
    selecionada: null,
    oferta: null,
  };
}

/**
 * A conversa de cada confirmação, como ela está quando o dia começa. A mensagem
 * de confirmação sai como template da Meta com botões, então a resposta volta
 * como payload fixo — sem IA no meio, que é o que o CLAUDE.md (regra 4) exige da
 * confirmação.
 */
function conversasIniciais(): Record<string, Conversa> {
  const pergunta = (c: ConsultaDemo): Mensagem => ({
    de: 'clinica',
    texto: `Olá, ${primeiroNome(c.paciente)}! Sua ${nomeDoProcedimento(c.procedimentoId).toLowerCase()} na Clínica Aurora é amanhã. Podemos confirmar?`,
    quando: 'ontem, 18:00',
  });

  const entradas = CONSULTAS.filter((c) => CONFIRMACOES.some((f) => f.consultaId === c.id)).map<
    [string, Conversa]
  >((c) => {
    const confirmacao = CONFIRMACOES.find((f) => f.consultaId === c.id);
    const mensagens: Mensagem[] = [pergunta(c)];

    if (confirmacao?.estado === 'confirmou') {
      mensagens.push({ de: 'paciente', texto: 'Confirmo', quando: 'ontem, 18:12' });
      mensagens.push({
        de: 'clinica',
        texto: 'Combinado, até amanhã. Se precisar mudar, responda por aqui.',
        quando: 'ontem, 18:12',
      });
    }
    if (confirmacao?.estado === 'recusou') {
      mensagens.push({ de: 'paciente', texto: 'Não vou poder', quando: 'ontem, 18:25' });
      mensagens.push({
        de: 'clinica',
        texto: 'Sem problema, liberei o horário. Já te chamo com outras opções.',
        quando: 'ontem, 18:25',
      });
    }

    return [c.id, { consultaId: c.id, paciente: c.paciente, mensagens, botoes: [] }];
  });

  return Object.fromEntries(entradas);
}

export function primeiroNome(nome: string): string {
  return nome.split(' ')[0] ?? nome;
}

export function nomeDoProcedimento(id: string): string {
  return PROCEDIMENTOS[id]?.nome ?? 'consulta';
}

// ---------- ajustes, todos imutáveis ----------

function comConsulta(e: Estado, id: string, f: (c: ConsultaDemo) => ConsultaDemo): Estado {
  return { ...e, consultas: e.consultas.map((c) => (c.id === id ? f(c) : c)) };
}

/** Recepção marcou a chegada do paciente. */
export function registrarChegada(e: Estado, id: string, minutoDoDia: number): Estado {
  return comConsulta(e, id, (c) => ({ ...c, chegouEm: minutoDoDia }));
}

/** Profissional começou o atendimento. */
export function iniciarAtendimento(e: Estado, id: string, minutoDoDia: number): Estado {
  return comConsulta(e, id, (c) => ({
    ...c,
    chegouEm: c.chegouEm ?? minutoDoDia,
    iniciadaEm: minutoDoDia,
  }));
}

/** Atendimento terminou: é aqui que a consulta vira realizada. */
export function finalizarAtendimento(e: Estado, id: string, minutoDoDia: number): Estado {
  return comConsulta(e, id, (c) => ({
    ...c,
    finalizadaEm: minutoDoDia,
    status: 'realizado',
  }));
}

export function comMensagem(e: Estado, conversaId: string, msg: Mensagem): Estado {
  const atual = e.conversas[conversaId];
  if (!atual) return e;
  return {
    ...e,
    conversas: {
      ...e.conversas,
      [conversaId]: { ...atual, mensagens: [...atual.mensagens, msg], botoes: [] },
    },
  };
}

export function comBotoes(e: Estado, conversaId: string, botoes: BotaoDoTemplate[]): Estado {
  const atual = e.conversas[conversaId];
  if (!atual) return e;
  return { ...e, conversas: { ...e.conversas, [conversaId]: { ...atual, botoes } } };
}

export function comConfirmacao(
  e: Estado,
  consultaId: string,
  estado: ConfirmacaoDemo['estado'],
  respondeuEm: number,
): Estado {
  return {
    ...e,
    confirmacoes: e.confirmacoes.map((f) =>
      f.consultaId === consultaId ? { ...f, estado, respondeuEm } : f,
    ),
  };
}

/** O horário saiu da agenda. Cancelada não desenha bloco: o lugar volta a ser hachura. */
export function liberarHorario(e: Estado, consultaId: string): Estado {
  return comConsulta(e, consultaId, (c) => ({ ...c, status: 'cancelado' }));
}

export function comEspera(e: Estado, id: string, estado: EsperaDemo['estado']): Estado {
  return { ...e, fila: e.fila.map((w) => (w.id === id ? { ...w, estado } : w)) };
}

/**
 * A vaga reocupada entra como consulta NOVA no mesmo horário, e a cancelada fica
 * onde está. São dois fatos diferentes do dia, e juntá-los num registro só
 * apagaria o que a clínica mais quer ver: que o horário não ficou vazio.
 */
export function reocuparHorario(
  e: Estado,
  consultaCancelada: ConsultaDemo,
  paciente: string,
): Estado {
  const nova: ConsultaDemo = {
    id: `${consultaCancelada.id}-reocupada`,
    profissionalId: consultaCancelada.profissionalId,
    marcadaEm: consultaCancelada.marcadaEm,
    paciente,
    procedimentoId: consultaCancelada.procedimentoId,
    status: 'confirmado',
  };
  return { ...e, consultas: [...e.consultas, nova] };
}
