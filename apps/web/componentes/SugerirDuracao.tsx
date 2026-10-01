import { aceitarDuracao } from '../app/acoes';
import type { SugestaoDeDuracaoNaTela } from '../lib/tipos';
import { Medida } from './Medida';

/**
 * O card da tela Hoje: a causa do atraso de hoje, com o conserto ao lado.
 *
 * Fica na Hoje, e não só na tela de pontualidade, porque é aqui que a recepção e o
 * dono passam o dia — e porque a decisão só é barata no dia em que aparece. Uma
 * ação por linha, como toda lista de decisão do painel.
 *
 * Não aparece para quem não é dono: a API devolve a lista vazia nesse caso.
 */
export function SugerirDuracao({ sugestoes }: { sugestoes: SugestaoDeDuracaoNaTela[] }) {
  if (sugestoes.length === 0) return null;

  const maior = Math.max(...sugestoes.flatMap((s) => [s.cadastradaMin, s.novaDuracaoMin]));

  return (
    <section className="bg-paper mt-5 rounded-lg p-5" data-testid="sugerir-duracao">
      <h2 className="text-base">A agenda está reservando o tempo errado</h2>
      <p className="text-ink-2 mt-1 text-sm">
        {sugestoes.length === 1
          ? 'Um procedimento leva um tempo diferente do que está no cadastro. O atraso da tarde começa aqui.'
          : `${String(sugestoes.length)} procedimentos levam um tempo diferente do que está no cadastro. O atraso da tarde começa aqui.`}
      </p>

      <ul className="mt-3">
        {sugestoes.map((s) => {
          const aMais = s.novaDuracaoMin > s.cadastradaMin;
          return (
            <li
              key={s.procedimentoId}
              className="border-fio flex flex-wrap items-center gap-4 border-b py-3 last:border-b-0"
            >
              <div className="min-w-[180px] flex-1">
                <p className="font-semibold">{s.nome}</p>
                <p className="text-ink-2 mt-0.5 text-[13px]">
                  Cadastrado <span className="font-mono">{s.cadastradaMin} min</span>, leva{' '}
                  <span className="font-mono">{s.medianaMin} min</span> na mediana de{' '}
                  <span className="font-mono">{s.amostra}</span> atendimentos.{' '}
                  {aMais
                    ? 'Cada consulta dessas empurra a seguinte.'
                    : 'Sobra tempo que dava para atender mais gente.'}
                </p>
              </div>

              <Medida planejado={s.cadastradaMin} real={s.novaDuracaoMin} maior={maior} />

              <form action={aceitarDuracao}>
                <input type="hidden" name="procedimento" value={s.procedimentoId} />
                <button
                  type="submit"
                  className="bg-ink text-paper rounded-pill px-3.5 py-1.5 text-[13px] font-semibold"
                >
                  Reservar {s.novaDuracaoMin} min
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
