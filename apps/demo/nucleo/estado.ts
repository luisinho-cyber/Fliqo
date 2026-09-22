import {
  CONSULTAS,
  LISTA_DE_ESPERA,
  type ConsultaDemo,
  type EsperaDemo,
  type StatusConsulta,
} from './dados';

export type Aba = 'dia' | 'conversas' | 'fila' | 'caixa' | 'pontualidade';
export type Dia = 'hoje' | 'amanha';

export interface Mensagem {
  de: 'clinica' | 'paciente' | 'sistema';
  texto: string;
  hora?: string;
}

export interface BotaoDaMensagem {
  rotulo: string;
  aoTocar: (api: ApiDeCena) => void | Promise<void>;
}

export interface Conversa {
  paciente: string;
  contexto: string;
  modo: 'assistente' | 'humano';
  mensagens: Mensagem[];
  botoes: BotaoDaMensagem[];
}

export type Severidade = 'risk' | 'late' | 'ok' | 'info';

export interface Decisao {
  id: string;
  severidade: Severidade;
  titulo: string;
  detalhe: string;
  acao?: string;
}

export interface Estado {
  aba: Aba;
  dia: Dia;
  consultas: ConsultaDemo[];
  fila: EsperaDemo[];
  conversas: Record<string, Conversa>;
  conversaAtiva: string;
  decisoes: Decisao[];
  selecionada: string | null;
  recuperadoCentavos: number;
  cena: number;
  tocando: boolean;
  apresentadorEscondido: boolean;
  aviso: string | null;
}

/** O que uma cena pode fazer. Cena nenhuma toca no DOM direto. */
export interface ApiDeCena {
  ajustar: (f: (e: Estado) => Estado) => void;
  esperar: (ms: number) => Promise<void>;
  avisar: (texto: string) => void;
}

export function estadoInicial(): Estado {
  return {
    aba: 'dia',
    dia: 'hoje',
    consultas: CONSULTAS.map((c) => ({ ...c })),
    fila: LISTA_DE_ESPERA.map((w) => ({ ...w })),
    conversas: {
      carla: {
        paciente: 'Carla Mendes',
        contexto: 'Toxina botulínica · amanhã 14:00',
        modo: 'assistente',
        mensagens: [],
        botoes: [],
      },
      mariana: {
        paciente: 'Mariana Teixeira',
        contexto: 'Lista de espera · toxina botulínica',
        modo: 'assistente',
        mensagens: [],
        botoes: [],
      },
      rodrigo: {
        paciente: 'Rodrigo Sales',
        contexto: 'Paciente novo',
        modo: 'assistente',
        mensagens: [],
        botoes: [],
      },
      lucas: {
        paciente: 'Lucas Martins',
        contexto: 'Toxina botulínica · hoje 12:10',
        modo: 'assistente',
        mensagens: [],
        botoes: [],
      },
      helena: {
        paciente: 'Helena Castro',
        contexto: 'Profilaxia · hoje 15:00',
        modo: 'assistente',
        mensagens: [],
        botoes: [],
      },
    },
    conversaAtiva: 'carla',
    decisoes: [],
    selecionada: null,
    recuperadoCentavos: 0,
    cena: 0,
    tocando: false,
    apresentadorEscondido: false,
    aviso: null,
  };
}

// ---------- ajustes, todos imutáveis ----------

export function mudarStatus(e: Estado, id: string, status: StatusConsulta): Estado {
  return { ...e, consultas: e.consultas.map((c) => (c.id === id ? { ...c, status } : c)) };
}

export function mudarEspera(e: Estado, id: string, estado: EsperaDemo['estado']): Estado {
  return { ...e, fila: e.fila.map((w) => (w.id === id ? { ...w, estado } : w)) };
}

export function comMensagem(e: Estado, conversa: string, msg: Mensagem): Estado {
  const atual = e.conversas[conversa];
  if (!atual) return e;
  return {
    ...e,
    conversas: {
      ...e.conversas,
      [conversa]: { ...atual, mensagens: [...atual.mensagens, msg], botoes: [] },
    },
  };
}

export function comBotoes(e: Estado, conversa: string, botoes: BotaoDaMensagem[]): Estado {
  const atual = e.conversas[conversa];
  if (!atual) return e;
  return { ...e, conversas: { ...e.conversas, [conversa]: { ...atual, botoes } } };
}

export function comModo(e: Estado, conversa: string, modo: Conversa['modo']): Estado {
  const atual = e.conversas[conversa];
  if (!atual) return e;
  return { ...e, conversas: { ...e.conversas, [conversa]: { ...atual, modo } } };
}

export function comDecisao(e: Estado, d: Decisao): Estado {
  return { ...e, decisoes: [d, ...e.decisoes.filter((x) => x.id !== d.id)] };
}

export function semDecisao(e: Estado, id: string): Estado {
  return { ...e, decisoes: e.decisoes.filter((d) => d.id !== id) };
}
