'use client';

import { duracaoEsperada, hhmm, previsaoDoDia } from '../nucleo/calculos';
import { PROCEDIMENTOS, PROFISSIONAIS, type ConsultaDemo } from '../nucleo/dados';
import type { Dia } from '../nucleo/estado';

/**
 * A Linha do Dia — a primeira assinatura do DESIGN.md.
 *
 * Cada profissional é uma faixa do dia. O bloco tem o tamanho da duração
 * REAL, não a da agenda: é por isso que o atraso aparece como deslocamento em
 * vez de número. Onde há atraso, o horário marcado fica como contorno tracejado
 * âmbar, ligado por uma seta. Dá para ver o problema sem ler nada.
 */

const JANELA_MINIMA_H = 6;

/**
 * A faixa cobre só o expediente que existe naquele dia. Uma janela fixa de 8h às
 * 19h espremeria os blocos a ponto de o nome do paciente não caber — e o ponto
 * da Linha do Dia é ler o dia sem clicar em nada.
 */
function janelaDoDia(consultas: ConsultaDemo[], dia: Dia): { inicioH: number; fimH: number } {
  const horas = consultas
    .filter((c) => c.dia === dia && c.status !== 'cancelado')
    .map((c) => {
      const [h, m] = c.horaAgendada.split(':').map(Number) as [number, number];
      return { inicio: h + m / 60, fim: h + (m + duracaoEsperada(c.procedimentoId)) / 60 };
    });
  if (horas.length === 0) return { inicioH: 8, fimH: 8 + JANELA_MINIMA_H };
  const inicioH = Math.floor(Math.min(...horas.map((x) => x.inicio)));
  const fim = Math.ceil(Math.max(...horas.map((x) => x.fim)) + 0.5);
  return { inicioH, fimH: Math.min(23, Math.max(fim, inicioH + JANELA_MINIMA_H)) };
}

interface Props {
  consultas: ConsultaDemo[];
  dia: Dia;
  agora: Date;
  selecionada: string | null;
  aoSelecionar: (id: string | null) => void;
}

export function LinhaDoDia({ consultas, dia, agora, selecionada, aoSelecionar }: Props) {
  const { inicioH, fimH } = janelaDoDia(consultas, dia);
  const janelaMin = (fimH - inicioH) * 60;
  const pct = (d: Date): number => {
    const min = (d.getHours() - inicioH) * 60 + d.getMinutes();
    return Math.max(0, Math.min(100, (min / janelaMin) * 100));
  };
  const larguraPct = (minutos: number): number => Math.max(1.5, (minutos / janelaMin) * 100);

  return (
    <div data-testid="linha-do-dia">
      {PROFISSIONAIS.map((prof) => {
        const doProf = consultas
          .filter((c) => c.dia === dia && c.profissionalId === prof.id)
          .sort((a, b) => a.horaAgendada.localeCompare(b.horaAgendada));
        const previsao = previsaoDoDia(consultas, dia, prof.id, agora);

        const atrasoMax = doProf.reduce((max, c) => {
          const p = previsao.get(c.id);
          return p && p.situacao !== 'finalizada' ? Math.max(max, p.atrasoMin) : max;
        }, 0);

        return (
          <div className="faixa" key={prof.id}>
            <div className="faixa-cab">
              <b>{prof.nome}</b>
              <span>
                {prof.especialidade}
                {atrasoMax >= 10
                  ? ` · cerca de ${String(Math.round(atrasoMax / 5) * 5)} min de atraso`
                  : ''}
              </span>
            </div>

            <div className="trilho" role="list" aria-label={`Agenda de ${prof.nome}`}>
              {Array.from({ length: fimH - inicioH + 1 }, (_, i) => inicioH + i).map((h) => (
                <div
                  key={h}
                  className="hora"
                  style={{ left: `${String(((h - inicioH) / (fimH - inicioH)) * 100)}%` }}
                >
                  {String(h).padStart(2, '0')}
                </div>
              ))}

              {dia === 'hoje' && (
                <div
                  className="agora"
                  data-t={`agora ${hhmm(agora)}`}
                  style={{ left: `${String(pct(agora))}%` }}
                />
              )}

              {doProf.map((c) => {
                const proc = PROCEDIMENTOS[c.procedimentoId];
                const p = previsao.get(c.id);
                const marcado = new Date(agora);
                const [hh, mm] = c.horaAgendada.split(':').map(Number) as [number, number];
                marcado.setHours(hh, mm, 0, 0);

                if (c.status === 'cancelado') {
                  return (
                    <div
                      key={c.id}
                      className="livre"
                      style={{
                        left: `${String(pct(marcado))}%`,
                        width: `${String(larguraPct(proc?.duracaoAgendaMin ?? 30))}%`,
                      }}
                      role="listitem"
                      data-testid={`livre-${c.id}`}
                    >
                      livre
                    </div>
                  );
                }

                const inicio = p ? p.inicioPrevisto : marcado;
                const atrasado = (p?.atrasoMin ?? 0) >= 10 && p?.situacao !== 'finalizada';
                const classes = [
                  'bloco',
                  c.status === 'confirmado' ? 'confirmado' : '',
                  c.status === 'agendado' ? 'aguardando' : '',
                  c.status === 'faltou' ? 'faltou' : '',
                  p?.situacao === 'em_atendimento' ? 'atendendo' : '',
                  atrasado ? 'atrasado' : '',
                  selecionada === c.id ? 'sel' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={c.id} role="listitem">
                    {atrasado && (
                      <>
                        <div
                          className="fantasma"
                          style={{
                            left: `${String(pct(marcado))}%`,
                            width: `${String(larguraPct(proc?.duracaoAgendaMin ?? 30))}%`,
                          }}
                        />
                        <div
                          className="seta"
                          style={{
                            left: `${String(pct(marcado))}%`,
                            width: `${String(Math.max(0, pct(inicio) - pct(marcado)))}%`,
                          }}
                        />
                      </>
                    )}
                    <button
                      className={classes}
                      style={{
                        left: `${String(pct(inicio))}%`,
                        width: `${String(larguraPct(duracaoEsperada(c.procedimentoId)))}%`,
                      }}
                      onClick={() => {
                        aoSelecionar(selecionada === c.id ? null : c.id);
                      }}
                      title={`${c.paciente} · ${proc?.nome ?? ''} · marcado ${c.horaAgendada}`}
                      data-testid={`bloco-${c.id}`}
                    >
                      <span className="mono">{hhmm(inicio)}</span> {c.paciente.split(' ')[0]}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
