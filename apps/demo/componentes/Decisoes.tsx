import type { Decisao } from '../nucleo/estado';

/**
 * Lista de decisões pendentes, com um glifo por severidade e uma única ação por
 * linha (DESIGN.md). Sem barra colorida na borda, sem card.
 */
export function Decisoes({
  decisoes,
  aoResolver,
}: {
  decisoes: Decisao[];
  aoResolver: (id: string) => void;
}) {
  if (decisoes.length === 0) {
    return (
      <p style={{ color: 'var(--ink-suave)', fontSize: 14 }}>
        Nada pendente agora. As decisões que precisam de alguém aparecem aqui.
      </p>
    );
  }

  return (
    <ul className="decisoes" data-testid="decisoes">
      {decisoes.map((d) => (
        <li className="decisao" key={d.id}>
          <span className={`glifo ${d.severidade}`} aria-hidden="true" />
          <div>
            <b>{d.titulo}</b>
            <p>{d.detalhe}</p>
          </div>
          {d.acao !== undefined && (
            <button
              className="acao"
              onClick={() => {
                aoResolver(d.id);
              }}
            >
              {d.acao}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
