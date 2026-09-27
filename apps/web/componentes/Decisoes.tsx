import { resolverDecisao } from '../app/acoes';
import type { DecisaoDaTela } from '../lib/tipos';

/**
 * A lista de decisões pendentes: um glifo por severidade e UMA ação por linha
 * (DESIGN.md). Sem barra colorida na borda, sem card, sem menu de três pontos.
 */
export function Decisoes({ decisoes }: { decisoes: DecisaoDaTela[] }) {
  if (decisoes.length === 0) {
    return (
      <p className="text-ink-suave text-sm">
        Nada pendente agora. O que precisar de alguém aparece aqui.
      </p>
    );
  }

  return (
    <ul className="m-0 list-none p-0" data-testid="decisoes">
      {decisoes.map((d) => (
        <li
          key={d.id}
          className="border-linha grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3 border-t py-3 first:border-t-0"
        >
          <span className={`glifo ${d.gravidade}`} aria-hidden="true" />
          <div>
            <b className="block font-bold">{d.titulo}</b>
            {d.detalhe !== null && <p className="text-ink-suave mt-0.5 text-[13px]">{d.detalhe}</p>}
          </div>
          <form action={resolverDecisao}>
            <input type="hidden" name="decisao" value={d.id} />
            <button
              type="submit"
              className="border-linha-forte bg-paper rounded-full border px-3 py-1 text-[13px] font-semibold"
            >
              Resolvido
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
