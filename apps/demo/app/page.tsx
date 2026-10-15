'use client';

import { useEffect, useMemo, useState } from 'react';
import { CanalDoPaciente } from '../componentes/CanalDoPaciente';
import { Confirmacao } from '../componentes/Confirmacao';
import { LinhaDoDia } from '../componentes/LinhaDoDia';
import { ListaDeEspera } from '../componentes/ListaDeEspera';
import { TresToques } from '../componentes/TresToques';
import { efeitoDoBotao, PAYLOAD_BOTOES, planoDaVaga } from '../nucleo/calculos';
import { CLINICA, type ConsultaDemo } from '../nucleo/dados';
import {
  comBotoes,
  comConfirmacao,
  comEspera,
  comMensagem,
  estadoInicial,
  finalizarAtendimento,
  iniciarAtendimento,
  liberarHorario,
  nomeDoProcedimento,
  primeiroNome,
  registrarChegada,
  reocuparHorario,
  type Aba,
  type Estado,
} from '../nucleo/estado';
import { comecoDoDia, hhmm, instanteDe } from '../nucleo/relogio';

const ABAS: { chave: Aba; rotulo: string }[] = [
  { chave: 'dia', rotulo: 'O dia' },
  { chave: 'confirmacao', rotulo: 'Confirmação' },
  { chave: 'espera', rotulo: 'Lista de espera' },
];

/** A linha do agora mostra este minuto, então o relógio precisa andar. */
const PASSO_DO_RELOGIO_MS = 15_000;

export default function Pagina() {
  const [estado, setEstado] = useState<Estado>(estadoInicial);
  /*
   * O dia só existe no navegador. A página é estática e seria gerada com a data
   * da publicação, então montar primeiro evita desenhar um dia errado por um
   * quadro — e evita que o servidor e o cliente discordem do relógio.
   */
  const [agora, setAgora] = useState<Date | null>(null);
  useEffect(() => {
    setAgora(new Date());
    const timer = setInterval(() => {
      setAgora(new Date());
    }, PASSO_DO_RELOGIO_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /*
   * O começo do dia é fixado na primeira montagem, não recalculado a cada tique:
   * recalcular faria a agenda inteira deslizar quando o relógio virasse a hora.
   */
  const [inicioDoDia, setInicioDoDia] = useState<Date | null>(null);
  useEffect(() => {
    setInicioDoDia(comecoDoDia(new Date()));
  }, []);

  const minutoDoDia = useMemo(
    () =>
      agora === null || inicioDoDia === null
        ? 0
        : Math.round((agora.getTime() - inicioDoDia.getTime()) / 60_000),
    [agora, inicioDoDia],
  );

  /*
   * A pergunta de confirmação que ainda está sem resposta é a única conversa com
   * botões de pé: é nela que quem apresenta toca.
   */
  useEffect(() => {
    setEstado((e) => {
      const aberta = e.confirmacoes.find((f) => f.estado === 'aguardando');
      if (!aberta) return e;
      const conversa = e.conversas[aberta.consultaId];
      if (!conversa || conversa.botoes.length > 0) return e;
      return comBotoes(e, aberta.consultaId, [
        { rotulo: 'Confirmar', payload: PAYLOAD_BOTOES.CONFIRMAR },
        { rotulo: 'Não vou poder', payload: PAYLOAD_BOTOES.CANCELAR },
      ]);
    });
  }, []);

  function responder(payload: string) {
    if (inicioDoDia === null || agora === null) return;
    // Const local, e não o state direto: o TypeScript não estreita `Date | null`
    // dentro das funções abaixo, e o guarda acima já respondeu a pergunta.
    const inicio = inicioDoDia;
    const momento = agora;
    const efeito = efeitoDoBotao(payload);

    setEstado((e) => {
      const conversa = e.conversas[e.conversaAtiva];
      if (!conversa) return e;
      const consulta = e.consultas.find((c) => c.id === conversa.consultaId);
      if (!consulta) return e;

      switch (efeito.acao) {
        case 'marcar_confirmado': {
          let proximo = comMensagem(e, e.conversaAtiva, {
            de: 'paciente',
            texto: 'Confirmo',
            quando: hhmm(momento),
          });
          proximo = comMensagem(proximo, e.conversaAtiva, {
            de: 'clinica',
            texto: 'Combinado, até lá. Se precisar mudar, responda por aqui.',
            quando: hhmm(momento),
          });
          proximo = comConfirmacao(proximo, consulta.id, 'confirmou', minutoDoDia);
          return {
            ...proximo,
            consultas: proximo.consultas.map((c) =>
              c.id === consulta.id ? { ...c, status: 'confirmado' } : c,
            ),
          };
        }

        case 'liberar_horario_e_ofertar':
          return liberarEOfertar(e, consulta);

        case 'aceitar_oferta':
          return aceitarOferta(e, consulta);

        default:
          return e;
      }
    });

    function liberarEOfertar(e: Estado, consulta: ConsultaDemo): Estado {
      let proximo = comMensagem(e, e.conversaAtiva, {
        de: 'paciente',
        texto: 'Não vou poder',
        quando: hhmm(momento),
      });
      proximo = comMensagem(proximo, e.conversaAtiva, {
        de: 'clinica',
        texto: 'Sem problema, liberei o horário. Já te chamo com outras opções.',
        quando: hhmm(momento),
      });
      proximo = comConfirmacao(proximo, consulta.id, 'recusou', minutoDoDia);
      proximo = liberarHorario(proximo, consulta.id);

      const inicioDaVaga = instanteDe(inicio, consulta.marcadaEm);
      const plano = planoDaVaga(inicioDaVaga, momento);
      if (!plano.ofertar) return { ...proximo, aba: 'espera' };

      const candidatos = proximo.fila
        .filter((w) => w.procedimentoId === consulta.procedimentoId && w.estado === 'aguardando')
        .slice(0, plano.quantos);

      for (const w of candidatos) proximo = comEspera(proximo, w.id, 'ofertado');

      const primeiro = candidatos[0];
      if (!primeiro) return { ...proximo, aba: 'espera' };

      return {
        ...proximo,
        aba: 'espera',
        oferta: { consultaId: consulta.id, expiraEm: plano.expiraEm, quantos: plano.quantos },
        conversaAtiva: primeiro.id,
        conversas: {
          ...proximo.conversas,
          [primeiro.id]: {
            consultaId: consulta.id,
            paciente: primeiro.paciente,
            mensagens: [
              {
                de: 'clinica',
                texto: `Olá, ${primeiroNome(primeiro.paciente)}! Abriu um horário de ${nomeDoProcedimento(
                  consulta.procedimentoId,
                ).toLowerCase()} hoje às ${hhmm(inicioDaVaga)}. Quer este horário?`,
                quando: hhmm(momento),
              },
            ],
            botoes: [{ rotulo: 'Quero este horário', payload: PAYLOAD_BOTOES.QUERO_VAGA }],
          },
        },
      };
    }

    function aceitarOferta(e: Estado, consulta: ConsultaDemo): Estado {
      const aceitou = e.fila.find((w) => w.id === e.conversaAtiva);
      if (!aceitou) return e;

      let proximo = comMensagem(e, e.conversaAtiva, {
        de: 'paciente',
        texto: 'Quero este horário',
        quando: hhmm(momento),
      });
      proximo = comMensagem(proximo, e.conversaAtiva, {
        de: 'clinica',
        texto: `Horário é seu: hoje às ${hhmm(instanteDe(inicio, consulta.marcadaEm))}. Até logo!`,
        quando: hhmm(momento),
      });

      for (const w of proximo.fila) {
        if (w.id === aceitou.id) proximo = comEspera(proximo, w.id, 'ficou_com_a_vaga');
        else if (w.estado === 'ofertado') proximo = comEspera(proximo, w.id, 'segue_na_fila');
      }

      proximo = reocuparHorario(proximo, consulta, aceitou.paciente);
      return { ...proximo, oferta: null, aba: 'dia' };
    }
  }

  const conversa = estado.conversas[estado.conversaAtiva];
  const pronto = agora !== null && inicioDoDia !== null;

  return (
    <div className="app">
      <header className="topo">
        <span className="marca">
          fliqo<i aria-hidden="true">.</i>
        </span>
        <nav className="abas" aria-label="Telas">
          {ABAS.map((a) => (
            <button
              key={a.chave}
              className="aba"
              aria-current={estado.aba === a.chave ? 'true' : 'false'}
              data-testid={`aba-${a.chave}`}
              onClick={() => {
                setEstado((e) => ({ ...e, aba: a.chave }));
              }}
            >
              {a.rotulo}
            </button>
          ))}
        </nav>
        <span className="clinica">{CLINICA.nome}</span>
      </header>

      <main className="corpo">
        <section className="painel">
          {!pronto ? (
            <p className="vazio">Carregando o dia da clínica…</p>
          ) : estado.aba === 'dia' ? (
            <>
              <LinhaDoDia
                consultas={estado.consultas}
                inicioDoDia={inicioDoDia}
                agora={agora}
                selecionada={estado.selecionada}
                aoSelecionar={(id) => {
                  setEstado((e) => ({ ...e, selecionada: id }));
                }}
              />
              <TresToques
                consultas={estado.consultas}
                selecionada={estado.selecionada}
                inicioDoDia={inicioDoDia}
                agora={agora}
                aoChegar={(id) => {
                  setEstado((e) => registrarChegada(e, id, minutoDoDia));
                }}
                aoIniciar={(id) => {
                  setEstado((e) => iniciarAtendimento(e, id, minutoDoDia));
                }}
                aoFinalizar={(id) => {
                  setEstado((e) => finalizarAtendimento(e, id, minutoDoDia));
                }}
              />
            </>
          ) : estado.aba === 'confirmacao' ? (
            <Confirmacao
              consultas={estado.consultas}
              confirmacoes={estado.confirmacoes}
              inicioDoDia={inicioDoDia}
              conversaAtiva={estado.conversaAtiva}
              aoAbrir={(consultaId) => {
                setEstado((e) => ({ ...e, conversaAtiva: consultaId }));
              }}
            />
          ) : (
            <ListaDeEspera fila={estado.fila} oferta={estado.oferta} />
          )}
        </section>

        <aside className="lateral">
          {conversa && <CanalDoPaciente conversa={conversa} aoResponder={responder} />}
        </aside>
      </main>

      <footer className="rodape">
        Ambiente de demonstração · dados fictícios · roda sem banco e sem WhatsApp
      </footer>
    </div>
  );
}
