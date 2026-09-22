import { DURACOES_REAIS, PROCEDIMENTOS, PROFISSIONAIS, type ConsultaDemo } from '../nucleo/dados';
import { pontualidadeDoDia, sugestaoDeDuracao } from '../nucleo/calculos';

/**
 * A causa do atraso, não o sintoma: onde a agenda reserva menos tempo do que o
 * procedimento leva. Sem isso, pedir pontualidade ao profissional é pedir o
 * impossível.
 */
export function Pontualidade({ consultas }: { consultas: ConsultaDemo[] }) {
  const sugestoes = Object.entries(PROCEDIMENTOS).map(([id, proc]) => ({
    id,
    proc,
    sugestao: sugestaoDeDuracao(id),
  }));
  const aAjustar = sugestoes.filter((s) => s.sugestao.sugerir);

  return (
    <div data-testid="pontualidade">
      <h2>Pontualidade</h2>

      <div className="figs" style={{ marginTop: 'var(--e-3)' }}>
        {PROFISSIONAIS.map((prof) => {
          const p = pontualidadeDoDia(consultas, prof.id);
          return (
            <div className="fig" key={prof.id}>
              <b>{p.atendimentos === 0 ? '—' : `${String(p.noHorarioPct)}%`}</b>
              <span>
                {prof.nome} no horário hoje
                {p.atendimentos > 0 && ` · atraso médio de ${String(p.atrasoMedioMin)} min`}
              </span>
            </div>
          );
        })}
      </div>

      <h3 style={{ marginTop: 'var(--e-5)' }}>Duração na agenda × duração real</h3>
      <p style={{ color: 'var(--ink-suave)', fontSize: 14, marginTop: 4 }}>
        {aAjustar.length === 0
          ? 'Nenhum procedimento com diferença grande o bastante para mexer na agenda.'
          : 'A agenda reserva menos tempo do que estes procedimentos levam. O atraso da tarde começa aqui.'}
      </p>

      <div className="tabela">
        <table>
          <thead>
            <tr>
              <th>Procedimento</th>
              <th className="num">Na agenda</th>
              <th className="num">Real (mediana)</th>
              <th className="num">Atendimentos</th>
              <th>Sugestão</th>
            </tr>
          </thead>
          <tbody>
            {sugestoes.map(({ id, proc, sugestao }) => (
              <tr key={id} data-testid={`duracao-${id}`}>
                <td>{proc.nome}</td>
                <td className="num">{proc.duracaoAgendaMin} min</td>
                <td className="num">
                  {sugestao.sugerir ? `${String(sugestao.medianaMin)} min` : '—'}
                </td>
                <td className="num">{DURACOES_REAIS[id]?.length ?? 0}</td>
                <td>
                  {sugestao.sugerir ? (
                    <span className="etq late">reservar {sugestao.novaDuracaoMin} min</span>
                  ) : (
                    <span style={{ color: 'var(--ink-suave)' }}>a agenda está certa</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
