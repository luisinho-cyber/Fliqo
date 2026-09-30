import { atrasoAproximado, primeiroNome } from '../lib/formato';
import { hhmm, janelaDoDia, largura, marcasDeHora, pct, type Bloco } from '../lib/linha';
import type { ConsultaDaTela, ProfissionalDaTela, VagaDaTela } from '../lib/tipos';
import { Agora } from './Agora';

/**
 * A Linha do Dia — a primeira assinatura do DESIGN.md.
 *
 * Cada profissional é uma faixa do dia. O bloco tem o tamanho da duração REAL e
 * fica onde a consulta vai começar DE VERDADE: é por isso que o atraso aparece
 * como deslocamento em vez de número. Onde há atraso, o horário marcado fica
 * como contorno tracejado âmbar, ligado por uma seta. Dá para ver o problema
 * sem ler nada.
 */

/** Abaixo disto ninguém remarca nada: é a hora normal de uma agenda respirar. */
const ATRASO_VISIVEL_MIN = 10;

const MIN = 60_000;

interface Props {
  profissionais: ProfissionalDaTela[];
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
  fuso: string;
  agoraMs: number;
}

export function LinhaDoDia({ profissionais, consultas, vagas, fuso, agoraMs }: Props) {
  const blocos: Bloco[] = consultas.map((c) => ({
    inicioMs: Math.min(Date.parse(c.inicioAgendado), Date.parse(c.inicioPrevisto)),
    fimMs: Date.parse(c.inicioPrevisto) + c.duracaoEsperadaMin * MIN,
  }));
  // Uma janela só para todas as faixas: duas escalas diferentes lado a lado
  // fariam 10h de uma parecer 14h da outra.
  const janela = janelaDoDia(blocos, agoraMs);
  const marcas = marcasDeHora(janela, fuso);

  return (
    <div data-testid="linha-do-dia">
      {profissionais.map((prof) => {
        const dele = consultas.filter((c) => c.profissionalId === prof.id);
        const vagasDele = vagas.filter((v) => v.profissionalId === prof.id);

        return (
          <div className="mb-5" key={prof.id}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <b className="font-titulo tracking-[-0.02em]">{prof.nome}</b>
              <span className="text-ink-2 text-[13px]">
                {prof.atrasoMin >= ATRASO_VISIVEL_MIN
                  ? `cerca de ${atrasoAproximado(prof.atrasoMin)} de atraso`
                  : 'no horário'}
              </span>
            </div>

            <div className="trilho" role="list" aria-label={`Agenda de ${prof.nome}`}>
              {marcas.map((m) => (
                <div key={m.rotulo} className="hora" style={{ left: `${String(m.pct)}%` }}>
                  {m.rotulo}
                </div>
              ))}

              <Agora janela={janela} fuso={fuso} />

              {vagasDele.map((v) => {
                const inicio = Date.parse(v.inicio);
                const fim = Date.parse(v.fim);
                return (
                  <div
                    key={`${prof.id}-${v.inicio}`}
                    className="livre"
                    style={{
                      left: `${String(pct(inicio, janela))}%`,
                      width: `${String(largura(fim - inicio, janela))}%`,
                    }}
                    role="listitem"
                    title={`Horário livre das ${hhmm(inicio, fuso)} às ${hhmm(fim, fuso)}`}
                  >
                    livre
                  </div>
                );
              })}

              {dele.map((c) => {
                const marcado = Date.parse(c.inicioAgendado);
                const previsto = Date.parse(c.inicioPrevisto);
                const duracaoMs = c.duracaoEsperadaMin * MIN;
                const atrasado = c.atrasoMin >= ATRASO_VISIVEL_MIN && c.situacao !== 'finalizada';

                // Cancelado é horário disponível: hachura, sem nome de paciente e
                // sem o tracejado do atraso. O que aconteceu fica na lista de
                // decisões, não na faixa.
                const cancelado = c.status === 'cancelado';

                const classes = [
                  'bloco',
                  cancelado ? 'cancelado' : '',
                  c.status === 'agendado' ? 'marcado' : '',
                  c.status === 'confirmado' ? 'confirmado' : '',
                  c.status === 'em_risco' ? 'em-risco' : '',
                  c.status === 'faltou' ? 'faltou' : '',
                  atrasado && !cancelado ? 'atrasado' : '',
                  c.situacao === 'em_atendimento' ? 'atendendo' : '',
                  c.situacao === 'finalizada' ? 'finalizada' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={c.id} role="listitem">
                    {atrasado && !cancelado && (
                      <>
                        <div
                          className="fantasma"
                          style={{
                            left: `${String(pct(marcado, janela))}%`,
                            width: `${String(largura(Date.parse(c.fimAgendado) - marcado, janela))}%`,
                          }}
                          aria-hidden="true"
                        />
                        <div
                          className="seta"
                          style={{
                            left: `${String(pct(marcado, janela))}%`,
                            width: `${String(Math.max(0, pct(previsto, janela) - pct(marcado, janela)))}%`,
                          }}
                          aria-hidden="true"
                        />
                      </>
                    )}
                    <div
                      className={classes}
                      style={{
                        left: `${String(pct(previsto, janela))}%`,
                        width: `${String(largura(duracaoMs, janela))}%`,
                      }}
                      title={
                        cancelado
                          ? `Horário livre desde o cancelamento das ${hhmm(marcado, fuso)}`
                          : `${c.paciente} · ${c.procedimento} · marcado ${hhmm(marcado, fuso)}${
                              atrasado ? ` · deve começar ${hhmm(previsto, fuso)}` : ''
                            }${c.chegou ? ' · já chegou' : ''}`
                      }
                      data-testid={`bloco-${c.id}`}
                    >
                      {!cancelado && (
                        <>
                          <span className="font-mono tabular-nums">{hhmm(previsto, fuso)}</span>{' '}
                          {primeiroNome(c.paciente)}
                        </>
                      )}
                    </div>
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
