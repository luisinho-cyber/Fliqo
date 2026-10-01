import { formatBRL } from '../lib/formato';
import type { Caixa as Dados, LinhaNaTela } from '../lib/tipos';
import { Medida } from './Medida';
import { Vazio } from './Avisos';

/**
 * O caixa: a distância entre o que está marcado e o que vai entrar de verdade.
 *
 * A manchete vem montada do servidor, e é de propósito: ela é a MESMA conta das
 * tabelas. Se esta tela remontasse a frase a partir dos números, duas formatações de
 * dinheiro poderiam divergir — e a primeira vez que a frase discordar da tabela, a
 * clínica para de confiar nas duas.
 *
 * Marcado × esperado usa o par vazado/cheio, igual ao atraso na faixa do dia e à
 * duração na Pontualidade: o planejado contra o que acontece. É a mesma ideia, então é
 * o mesmo desenho.
 */
export function Caixa({ dados }: { dados: Dados }) {
  const d = dados;
  const maior = Math.max(
    1,
    ...d.porProfissional.map((l) => l.marcadoCents),
    ...d.porProcedimento.map((l) => l.marcadoCents),
  );

  return (
    <>
      <section className="bg-paper rounded-lg p-5">
        <h1 className="text-xl">Caixa</h1>
        {/* A manchete é a frase, não cartão de indicador (DESIGN.md). */}
        <p className="mt-2 text-lg">{d.manchete}</p>
        <p className="text-ink-2 mt-1 text-sm">
          De {diaCurto(d.de)} a {diaCurto(d.ate)}. Marcado é o que está na agenda; esperado é o que
          deve entrar de verdade, já descontada a chance de cada consulta não acontecer.
          {d.realizadoCents > 0 ? (
            <>
              {' '}
              Já entrou{' '}
              <span className="font-mono tabular-nums">{formatBRL(d.realizadoCents)}</span>.
            </>
          ) : null}
        </p>

        {d.faltas.quantidade > 0 ? (
          <p className="mt-3 text-sm">
            <span className="font-semibold">
              {d.faltas.quantidade === 1
                ? '1 falta neste período'
                : `${String(d.faltas.quantidade)} faltas neste período`}
            </span>
            , <span className="font-mono tabular-nums">{formatBRL(d.faltas.valorCents)}</span> que
            estavam na agenda e não entraram.
          </p>
        ) : null}
      </section>

      {d.semPreco.procedimentos.length > 0 ? <SemPreco semPreco={d.semPreco} /> : null}

      <Eixo
        titulo="Por profissional"
        linhas={d.porProfissional}
        maior={maior}
        vazio="Nenhuma consulta com preço cadastrado neste período."
      />
      <Eixo
        titulo="Por procedimento"
        linhas={d.porProcedimento}
        maior={maior}
        vazio="Nenhum procedimento com preço cadastrado neste período."
      />
    </>
  );
}

/**
 * Os procedimentos sem preço cadastrado, com caminho para o conserto.
 *
 * Eles saem das somas em vez de entrar como R$ 0: preço zero tem dois significados, e
 * somar "ninguém cadastrou" junto com "é cortesia" faria esta tela mentir com cara de
 * verde — que é a pior forma de errar um número de dinheiro.
 */
function SemPreco({ semPreco }: { semPreco: Dados['semPreco'] }) {
  const n = semPreco.procedimentos.length;
  return (
    <section className="bg-paper mt-5 rounded-lg p-5">
      <h2 className="text-base">
        {n === 1
          ? '1 procedimento sem preço cadastrado'
          : `${String(n)} procedimentos sem preço cadastrado`}
      </h2>
      <p className="text-ink-2 mt-1 text-sm">
        {semPreco.consultas === 1
          ? '1 consulta ficou fora das contas acima'
          : `${String(semPreco.consultas)} consultas ficaram fora das contas acima`}{' '}
        porque não se sabe quanto valem. Elas vieram da agenda importada, onde o preço fica no outro
        sistema. Com o preço cadastrado, as próximas entram na conta.
      </p>
      {/*
        Sem link para o cadastro: não existe tela de cadastro de procedimento na Fliqo
        hoje — nem aqui, nem em configurações. Link que dá 404 é pior do que link
        nenhum, e a lista de nomes já é o que a pessoa precisa para agir.
      */}
      <ul className="mt-3">
        {semPreco.procedimentos.map((p) => (
          <li
            key={p.id}
            className="border-fio flex flex-wrap items-center gap-3 border-b py-2 text-sm last:border-b-0"
          >
            <span className="min-w-[160px] flex-1 font-semibold">{p.nome}</span>
            <span className="text-ink-2 font-mono tabular-nums">sem preço</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Eixo({
  titulo,
  linhas,
  maior,
  vazio,
}: {
  titulo: string;
  linhas: LinhaNaTela[];
  maior: number;
  vazio: string;
}) {
  return (
    <section className="bg-paper mt-5 rounded-lg p-5">
      <h2 className="text-base">{titulo}</h2>
      {linhas.length === 0 ? (
        <div className="mt-3">
          <Vazio
            titulo={vazio}
            detalhe="Assim que houver consulta com preço no período escolhido, a comparação aparece aqui."
          />
        </div>
      ) : (
        <table className="mt-3 w-full">
          <thead>
            <tr className="text-ink-2 border-fio border-b text-left text-[13px]">
              <th className="py-2 font-semibold">Nome</th>
              <th className="py-2 text-right font-semibold">Consultas</th>
              <th className="py-2 text-right font-semibold">Marcado</th>
              <th className="py-2 text-right font-semibold">Esperado</th>
              <th className="py-2 text-right font-semibold">Realizado</th>
              <th className="py-2 font-semibold">Marcado × esperado</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.id} className="border-fio border-b last:border-b-0">
                <td className="py-3">{l.nome}</td>
                <td className="py-3 text-right font-mono tabular-nums">{l.consultas}</td>
                {/* Dinheiro sempre à direita e em monoespaçada (DESIGN.md). */}
                <td className="py-3 text-right font-mono tabular-nums">
                  {formatBRL(l.marcadoCents)}
                </td>
                <td className="py-3 text-right font-mono tabular-nums">
                  {formatBRL(l.esperadoCents)}
                </td>
                <td className="py-3 text-right font-mono tabular-nums">
                  {formatBRL(l.realizadoCents)}
                </td>
                <td className="py-3">
                  {/* Vazado = marcado (o planejado), cheio = esperado. A distância é o assunto. */}
                  <Medida planejado={l.marcadoCents} real={l.esperadoCents} maior={maior} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function diaCurto(iso: string): string {
  const [ano, mes, dia] = iso.split('-');
  return dia === undefined || mes === undefined || ano === undefined ? iso : `${dia}/${mes}/${ano}`;
}
