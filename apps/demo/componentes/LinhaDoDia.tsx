'use client';

import { consultasDoProfissional, duracaoEsperada, previsaoDoDia } from '../nucleo/calculos';
import { PROCEDIMENTOS, PROFISSIONAIS, type ConsultaDemo } from '../nucleo/dados';
import { hhmm, instanteDe } from '../nucleo/relogio';

/**
 * A Linha do Dia — a primeira assinatura do DESIGN.md.
 *
 * Cada profissional é uma faixa do dia. O bloco tem o tamanho da duração REAL e
 * fica na posição em que vai começar DE VERDADE; onde há atraso, o horário
 * marcado continua desenhado no lugar onde estava, como contorno tracejado. A
 * distância entre o tracejado e o bloco sólido É o atraso — não há número para
 * ler, e é isso que se quer.
 *
 * O fundo da faixa é hachura: horário livre é ausência desenhada, nunca branco.
 * Consulta cancelada não desenha bloco nenhum, porque o que ela deixou atrás foi
 * exatamente isto — horário disponível.
 */

const JANELA_MINIMA_MIN = 420;
const LIMIAR_DE_DESLOCAMENTO_MIN = 10;

interface Props {
  consultas: ConsultaDemo[];
  inicioDoDia: Date;
  agora: Date;
  selecionada: string | null;
  aoSelecionar: (id: string | null) => void;
}

function janelaDoDia(consultas: ConsultaDemo[]): { de: number; ate: number } {
  const ativas = consultas.filter((c) => c.status !== 'cancelado');
  if (ativas.length === 0) return { de: 0, ate: JANELA_MINIMA_MIN };
  const primeira = Math.min(...ativas.map((c) => c.marcadaEm));
  const ultima = Math.max(...ativas.map((c) => c.marcadaEm + duracaoEsperada(c.procedimentoId)));
  // Meia hora de folga no fim: bloco encostado na borda parece cortado.
  const de = Math.min(0, Math.floor(primeira / 60) * 60);
  return { de, ate: Math.max(ultima + 30, de + JANELA_MINIMA_MIN) };
}

export function LinhaDoDia({ consultas, inicioDoDia, agora, selecionada, aoSelecionar }: Props) {
  const { de, ate } = janelaDoDia(consultas);
  const janela = ate - de;
  const pct = (minutoDoDia: number): number =>
    Math.max(0, Math.min(100, ((minutoDoDia - de) / janela) * 100));
  const largura = (minutos: number): number => Math.max(2, (minutos / janela) * 100);

  const minutoAgora = Math.round((agora.getTime() - inicioDoDia.getTime()) / 60_000);
  // `de` é múltiplo de 60, então a régua cai sempre na hora cheia.
  const horas = Array.from({ length: Math.floor(janela / 60) + 1 }, (_, i) => de + i * 60);

  return (
    <div data-testid="linha-do-dia">
      {PROFISSIONAIS.map((prof) => {
        const doProf = consultasDoProfissional(consultas, prof.id);
        const previsao = previsaoDoDia(consultas, prof.id, inicioDoDia, agora);

        return (
          <section className="faixa" key={prof.id}>
            <header className="faixa-cab">
              <b>{prof.nome}</b>
              <span>{prof.especialidade}</span>
            </header>

            <div
              className="trilho"
              role="list"
              aria-label={`Agenda de ${prof.nome}`}
              data-testid={`trilho-${prof.id}`}
            >
              {horas.map((m) => (
                <div key={m} className="tick" style={{ left: `${String(pct(m))}%` }}>
                  <span className="mono">{hhmm(instanteDe(inicioDoDia, m))}</span>
                </div>
              ))}

              <div
                className="agora"
                style={{ left: `${String(pct(minutoAgora))}%` }}
                data-testid={`agora-${prof.id}`}
              >
                <span className="agora-etiqueta mono">{hhmm(agora)}</span>
              </div>

              {doProf.map((c) => {
                // Cancelada é hachura, e a hachura é o fundo da faixa: nada a desenhar.
                if (c.status === 'cancelado') return null;

                const proc = PROCEDIMENTOS[c.procedimentoId];
                const p = previsao.get(c.id);
                const minutoPrevisto = p
                  ? Math.round((p.inicioPrevisto.getTime() - inicioDoDia.getTime()) / 60_000)
                  : c.marcadaEm;
                const deslocado =
                  (p?.atrasoMin ?? 0) >= LIMIAR_DE_DESLOCAMENTO_MIN && p?.situacao !== 'finalizada';

                const classes = [
                  'bloco',
                  c.status === 'agendado' ? 'sem-confirmar' : '',
                  c.status === 'confirmado' ? 'confirmado' : '',
                  c.status === 'faltou' ? 'faltou' : '',
                  p?.situacao === 'em_atendimento' ? 'atendendo' : '',
                  p?.situacao === 'finalizada' ? 'finalizada' : '',
                  deslocado ? 'deslocado' : '',
                  selecionada === c.id ? 'sel' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={c.id} role="listitem">
                    {deslocado && (
                      <div
                        className="marcado"
                        style={{
                          left: `${String(pct(c.marcadaEm))}%`,
                          width: `${String(largura(proc?.duracaoAgendaMin ?? 30))}%`,
                        }}
                        data-testid={`marcado-${c.id}`}
                        aria-hidden="true"
                      />
                    )}
                    <button
                      className={classes}
                      style={{
                        left: `${String(pct(minutoPrevisto))}%`,
                        width: `${String(largura(duracaoEsperada(c.procedimentoId)))}%`,
                      }}
                      onClick={() => {
                        aoSelecionar(selecionada === c.id ? null : c.id);
                      }}
                      data-testid={`bloco-${c.id}`}
                      aria-label={`${c.paciente}, ${proc?.nome ?? 'consulta'}, marcado para ${hhmm(
                        instanteDe(inicioDoDia, c.marcadaEm),
                      )}${
                        deslocado ? `, começa ${hhmm(instanteDe(inicioDoDia, minutoPrevisto))}` : ''
                      }`}
                    >
                      <span className="bloco-hora mono">
                        {hhmm(instanteDe(inicioDoDia, minutoPrevisto))}
                      </span>
                      <span className="bloco-nome">{c.paciente.split(' ')[0]}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
