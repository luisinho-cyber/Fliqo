import { aceitarDuracao } from '../app/acoes';
import type { Pontualidade as Dados } from '../lib/tipos';
import { Medida } from './Medida';
import { Vazio } from './Avisos';

/**
 * Pontualidade: o sintoma em cima, a causa embaixo.
 *
 * Nessa ordem de propósito. Atraso médio é o que o dono sente e não consegue
 * consertar — ninguém decide chegar no horário. A duração cadastrada errada é uma
 * linha no cadastro, e é ela que produz o atraso todo dia. A tela leva os olhos do
 * sintoma para o conserto.
 */
export function Pontualidade({ dados }: { dados: Dados }) {
  const comAtendimento = dados.profissionais.filter((p) => p.atendimentos > 0);
  const maior = Math.max(
    30,
    ...dados.procedimentos.flatMap((p) => [p.cadastradaMin, Math.ceil(p.medianaMin)]),
  );
  const aAjustar = dados.procedimentos.filter((p) => p.sugestao.sugerir).length;

  return (
    <>
      <section className="bg-paper rounded-lg p-5">
        <h1 className="text-xl">Pontualidade</h1>
        <p className="text-ink-2 mt-1 text-sm">
          De {diaCurto(dados.de)} a {diaCurto(dados.ate)}. No horário quer dizer começar até dez
          minutos depois do marcado.
        </p>

        {comAtendimento.length === 0 ? (
          <div className="mt-4">
            <Vazio
              titulo="Ainda não há atendimento registrado neste período."
              detalhe="A conta usa a hora em que o atendimento começou de verdade, que é o toque de iniciar na tela de hoje. Sem esse toque não há pontualidade para medir."
            />
          </div>
        ) : (
          <ul className="mt-4">
            {comAtendimento.map((p) => (
              <li
                key={p.id}
                className="border-fio flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-3 last:border-b-0"
              >
                <span className="min-w-[160px] flex-1 font-semibold">{p.nome}</span>
                <span className="font-mono text-lg">
                  {p.noHorarioPct === null ? '—' : `${String(p.noHorarioPct)}%`}
                </span>
                <span className="text-ink-2 text-[13px]">
                  no horário em <span className="font-mono">{p.atendimentos}</span> atendimentos ·
                  atraso médio de <span className="font-mono">{p.atrasoMedioMin} min</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-paper mt-5 rounded-lg p-5">
        <h2 className="text-base">Duração cadastrada × duração real</h2>
        <p className="text-ink-2 mt-1 text-sm">
          {aAjustar === 0
            ? 'Nenhum procedimento com diferença grande o bastante para mexer no cadastro. A barra tracejada é o tempo que a agenda reserva; a cheia é o que o procedimento leva.'
            : 'A barra tracejada é o tempo que a agenda reserva; a cheia é o que o procedimento leva. A distância entre as duas é de onde vem o atraso da tarde.'}
        </p>

        {dados.procedimentos.length === 0 ? (
          <div className="mt-4">
            <Vazio
              titulo="Nenhum procedimento foi realizado nos últimos 90 dias."
              detalhe="A duração real sai dos atendimentos finalizados. Assim que a clínica registrar os primeiros, a comparação aparece aqui."
            />
          </div>
        ) : (
          <table className="mt-4 w-full">
            <thead>
              <tr className="text-ink-2 border-fio border-b text-left text-[13px]">
                <th className="py-2 font-semibold">Procedimento</th>
                <th className="py-2 text-right font-semibold">Cadastrado</th>
                <th className="py-2 text-right font-semibold">Real (mediana)</th>
                <th className="py-2 text-right font-semibold">Atendimentos</th>
                <th className="py-2 font-semibold">Comparação</th>
                <th className="py-2 font-semibold">Sugestão</th>
              </tr>
            </thead>
            <tbody>
              {dados.procedimentos.map((p) => (
                <tr key={p.id} className="border-fio border-b last:border-b-0">
                  <td className="py-3">
                    {p.nome}
                    {p.ajustadaEm === null ? null : (
                      <span className="text-ink-2 block text-[12px]">
                        cadastro ajustado em {diaCurto(p.ajustadaEm.slice(0, 10))}
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-right font-mono">{p.cadastradaMin} min</td>
                  <td className="py-3 text-right font-mono">{p.medianaMin} min</td>
                  <td className="py-3 text-right font-mono">{p.amostra}</td>
                  <td className="py-3">
                    <Medida
                      cadastradaMin={p.cadastradaMin}
                      realMin={Math.ceil(p.medianaMin)}
                      maiorMin={maior}
                    />
                  </td>
                  <td className="py-3">
                    {p.sugestao.sugerir ? (
                      <form action={aceitarDuracao}>
                        <input type="hidden" name="procedimento" value={p.id} />
                        <button
                          type="submit"
                          className="bg-ink text-paper rounded-pill px-3 py-1 text-[13px] font-semibold"
                        >
                          Reservar {p.sugestao.novaDuracaoMin} min
                        </button>
                      </form>
                    ) : (
                      <span className="text-ink-2 text-[13px]">
                        {semSugestao(p.sugestao.motivo)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/**
 * As duas recusas são notícias diferentes, e a tela não pode dar a mesma frase às
 * duas: uma volta a ser sugestão quando houver mais atendimento, a outra quer dizer
 * que o cadastro está certo.
 */
function semSugestao(motivo: 'amostra_pequena' | 'divergencia_pequena'): string {
  return motivo === 'amostra_pequena'
    ? 'poucos atendimentos para afirmar'
    : 'o cadastro está certo';
}

function diaCurto(iso: string): string {
  const [ano, mes, dia] = iso.split('-');
  return dia === undefined || mes === undefined || ano === undefined ? iso : `${dia}/${mes}/${ano}`;
}
