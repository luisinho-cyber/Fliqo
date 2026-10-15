'use client';

import { duracaoEsperada, previsaoDoDia } from '../nucleo/calculos';
import { PROCEDIMENTOS, PROFISSIONAIS, type ConsultaDemo } from '../nucleo/dados';
import { hhmm, instanteDe } from '../nucleo/relogio';

/**
 * Os três toques do dia, do jeito que a recepção e o profissional tocam neles:
 * chegou, iniciar, finalizar. São os mesmos três do produto — não há um quarto
 * botão escondido aqui, e nenhum deles é decorativo: cada um grava um instante na
 * consulta, e é desse instante que `projetarDia` tira o dia inteiro.
 *
 * O toque que não cabe fica desligado com o motivo escrito, em vez de
 * desaparecer: a recepção precisa saber por que não pode iniciar, e "o paciente
 * ainda não chegou" é a resposta.
 */

interface Props {
  consultas: ConsultaDemo[];
  selecionada: string | null;
  inicioDoDia: Date;
  agora: Date;
  aoChegar: (id: string) => void;
  aoIniciar: (id: string) => void;
  aoFinalizar: (id: string) => void;
}

export function TresToques({
  consultas,
  selecionada,
  inicioDoDia,
  agora,
  aoChegar,
  aoIniciar,
  aoFinalizar,
}: Props) {
  const c = consultas.find((x) => x.id === selecionada);

  if (!c) {
    return (
      <div className="toques" data-testid="tres-toques">
        <p className="vazio">
          Toque num horário da faixa para marcar chegada, iniciar ou finalizar o atendimento.
        </p>
      </div>
    );
  }

  const proc = PROCEDIMENTOS[c.procedimentoId];
  const prof = PROFISSIONAIS.find((p) => p.id === c.profissionalId);
  const previsao = previsaoDoDia(consultas, c.profissionalId, inicioDoDia, agora).get(c.id);
  const chegou = c.chegouEm !== undefined;
  const iniciada = c.iniciadaEm !== undefined;
  const finalizada = c.finalizadaEm !== undefined;

  return (
    <div className="toques" data-testid="tres-toques">
      <div className="toques-cab">
        <b>{c.paciente}</b>
        <span>
          {proc?.nome ?? 'Consulta'} · {prof?.nome ?? ''} · marcado para{' '}
          <span className="mono">{hhmm(instanteDe(inicioDoDia, c.marcadaEm))}</span> ·{' '}
          {duracaoEsperada(c.procedimentoId)} min
        </span>
      </div>

      <dl className="instantes">
        <div>
          <dt>Chegou</dt>
          <dd className="mono" data-testid="instante-chegou">
            {chegou ? hhmm(instanteDe(inicioDoDia, c.chegouEm ?? 0)) : '—'}
          </dd>
        </div>
        <div>
          <dt>Começou</dt>
          <dd className="mono" data-testid="instante-iniciou">
            {iniciada ? hhmm(instanteDe(inicioDoDia, c.iniciadaEm ?? 0)) : '—'}
          </dd>
        </div>
        <div>
          <dt>Terminou</dt>
          <dd className="mono" data-testid="instante-finalizou">
            {finalizada ? hhmm(instanteDe(inicioDoDia, c.finalizadaEm ?? 0)) : '—'}
          </dd>
        </div>
      </dl>

      <div className="acoes">
        <button
          className="acao"
          disabled={chegou}
          onClick={() => {
            aoChegar(c.id);
          }}
          data-testid="toque-chegou"
        >
          {chegou ? 'Chegada já registrada' : 'Paciente chegou'}
        </button>
        <button
          className="acao"
          disabled={!chegou || iniciada}
          onClick={() => {
            aoIniciar(c.id);
          }}
          data-testid="toque-iniciar"
        >
          {iniciada ? 'Atendimento em curso' : 'Iniciar atendimento'}
        </button>
        <button
          className="acao"
          disabled={!iniciada || finalizada}
          onClick={() => {
            aoFinalizar(c.id);
          }}
          data-testid="toque-finalizar"
        >
          {finalizada ? 'Atendimento finalizado' : 'Finalizar atendimento'}
        </button>
      </div>

      {!chegou && (
        <p className="motivo" data-testid="motivo">
          O paciente ainda não chegou, então não dá para iniciar.
        </p>
      )}
      {previsao?.situacao === 'aguardando' && previsao.atrasoMin >= 10 && (
        <p className="motivo" data-testid="motivo-atraso">
          Este horário começa depois do que foi marcado porque o atendimento anterior ainda está em
          curso.
        </p>
      )}
    </div>
  );
}
