import { ativarProcedimento, salvarProcedimento } from '../app/acoes';
import { formatBRL } from '../lib/formato';
import type { ProcedimentoNaTela, Procedimentos as Dados } from '../lib/tipos';
import { Vazio } from './Avisos';

/**
 * O cadastro de procedimentos.
 *
 * É a pá que faltava: o Caixa contava "N procedimentos sem preço cadastrado" e não tinha
 * para onde mandar a clínica. O aviso do topo é a mesma contagem, vinda da mesma pergunta
 * — se as duas telas discordassem, a clínica cadastraria aqui e o Caixa continuaria
 * reclamando.
 */
export function Procedimentos({ dados }: { dados: Dados }) {
  const pendentes = dados.procedimentos.filter((p) => p.semPreco);

  return (
    <>
      {pendentes.length > 0 ? <SemPreco pendentes={pendentes} /> : null}

      <section className="bg-paper mt-5 rounded-lg p-5">
        <h1 className="text-xl">Procedimentos</h1>
        <p className="text-ink-2 mt-1 text-sm">
          A duração daqui é o que a agenda reserva, e o preço é o que entra no caixa de cada
          consulta nova. Preço que você mudar hoje <strong>não</strong> altera consulta que já
          aconteceu: cada uma guarda o preço do dia em que foi marcada.
        </p>

        {dados.procedimentos.length === 0 ? (
          <div className="mt-4">
            <Vazio
              titulo="Nenhum procedimento cadastrado ainda."
              detalhe="Cadastre o primeiro no formulário abaixo. Sem procedimento não há o que marcar na agenda."
            />
          </div>
        ) : (
          <table className="mt-4 w-full">
            <thead>
              <tr className="text-ink-2 border-fio border-b text-left text-[13px]">
                <th className="py-2 font-semibold">Procedimento</th>
                <th className="py-2 text-right font-semibold">Duração</th>
                <th className="py-2 text-right font-semibold">Preço</th>
                <th className="py-2 text-right font-semibold">Consultas</th>
                {dados.podeEditar ? <th className="py-2 font-semibold">Situação</th> : null}
              </tr>
            </thead>
            <tbody>
              {dados.procedimentos.map((p) => (
                <Linha key={p.id} p={p} podeEditar={dados.podeEditar} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {dados.podeEditar ? <Formulario /> : <SoLeitura />}
    </>
  );
}

/** O aviso do topo: é a lista que o Caixa já produz, com o caminho para resolver. */
function SemPreco({ pendentes }: { pendentes: ProcedimentoNaTela[] }) {
  return (
    <section className="border-risco bg-risco-tinta rounded-lg border p-5">
      <h2 className="text-base font-semibold">
        {pendentes.length === 1
          ? '1 procedimento está sem preço cadastrado'
          : `${String(pendentes.length)} procedimentos estão sem preço cadastrado`}
      </h2>
      <p className="mt-1 text-sm">
        Eles vieram da agenda importada, onde o preço fica no outro sistema. Enquanto estiverem
        assim, as consultas deles ficam <strong>fora</strong> das contas do caixa — não entram como
        zero, porque não se sabe quanto valem.
      </p>
      <ul className="mt-3">
        {pendentes.map((p) => (
          <li
            key={p.id}
            className="border-fio flex flex-wrap gap-3 border-b py-2 text-sm last:border-b-0"
          >
            <span className="min-w-[160px] flex-1 font-semibold">{p.nome}</span>
            <span className="font-mono tabular-nums">
              {p.consultas === 1 ? '1 consulta' : `${String(p.consultas)} consultas`}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm">Cadastre o preço de cada um na tabela abaixo.</p>
    </section>
  );
}

function Linha({ p, podeEditar }: { p: ProcedimentoNaTela; podeEditar: boolean }) {
  if (!podeEditar) {
    return (
      <tr className={`border-fio border-b last:border-b-0 ${p.ativo ? '' : 'text-ink-2'}`}>
        <td className="py-3">
          {p.nome}
          <Marcas p={p} />
        </td>
        <td className="py-3 text-right font-mono tabular-nums">{p.duracaoMinutos} min</td>
        <td className="py-3 text-right font-mono tabular-nums">
          {p.semPreco ? '—' : formatBRL(p.precoCents)}
        </td>
        <td className="py-3 text-right font-mono tabular-nums">{p.consultas}</td>
      </tr>
    );
  }

  return (
    <tr className={`border-fio border-b last:border-b-0 ${p.ativo ? '' : 'text-ink-2'}`}>
      <td className="py-3">
        <form action={salvarProcedimento} id={`f-${p.id}`} className="contents">
          <input type="hidden" name="procedimento" value={p.id} />
          <label className="sr-only" htmlFor={`nome-${p.id}`}>
            Nome do procedimento
          </label>
          <input
            id={`nome-${p.id}`}
            name="nome"
            defaultValue={p.nome}
            form={`f-${p.id}`}
            className="border-fio bg-paper text-ink w-full rounded-sm border px-2 py-1 text-sm"
          />
        </form>
        <Marcas p={p} />
      </td>
      <td className="py-3 text-right">
        <label className="sr-only" htmlFor={`duracao-${p.id}`}>
          Duração em minutos
        </label>
        <input
          id={`duracao-${p.id}`}
          name="duracao"
          type="number"
          min={5}
          max={600}
          step={5}
          defaultValue={p.duracaoMinutos}
          form={`f-${p.id}`}
          className="border-fio bg-paper text-ink w-20 rounded-sm border px-2 py-1 text-right font-mono text-sm tabular-nums"
        />
      </td>
      <td className="py-3 text-right">
        <label className="sr-only" htmlFor={`preco-${p.id}`}>
          Preço em reais
        </label>
        <input
          id={`preco-${p.id}`}
          name="preco"
          inputMode="decimal"
          defaultValue={p.semPreco ? '' : (p.precoCents / 100).toFixed(2).replace('.', ',')}
          placeholder="0,00"
          form={`f-${p.id}`}
          className="border-fio bg-paper text-ink w-28 rounded-sm border px-2 py-1 text-right font-mono text-sm tabular-nums"
        />
      </td>
      <td className="py-3 text-right font-mono tabular-nums">{p.consultas}</td>
      <td className="py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            form={`f-${p.id}`}
            className="bg-ink text-paper rounded-pill px-3 py-1 text-[13px] font-semibold"
          >
            Salvar
          </button>
          <form action={ativarProcedimento}>
            <input type="hidden" name="procedimento" value={p.id} />
            <input type="hidden" name="ativo" value={p.ativo ? 'nao' : 'sim'} />
            <button type="submit" className="border-fio rounded-pill border px-3 py-1 text-[13px]">
              {p.ativo ? 'Inativar' : 'Reativar'}
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
}

/** As marcas da linha: de onde veio, e se está fora da agenda. */
function Marcas({ p }: { p: ProcedimentoNaTela }) {
  if (!p.daImportacao && p.ativo) return null;
  return (
    <span className="text-ink-2 mt-0.5 block text-[12px]">
      {p.daImportacao
        ? p.semPreco
          ? 'veio da importação, sem preço'
          : 'veio da importação'
        : null}
      {p.daImportacao && !p.ativo ? ' · ' : null}
      {p.ativo ? null : 'inativo: não aparece para marcar, e o histórico continua inteiro'}
    </span>
  );
}

function Formulario() {
  return (
    <section className="bg-paper mt-5 rounded-lg p-5">
      <h2 className="text-base">Cadastrar procedimento</h2>
      <form action={salvarProcedimento} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="block text-[13px] font-semibold" htmlFor="novo-nome">
            Nome
          </label>
          <input
            id="novo-nome"
            name="nome"
            required
            minLength={2}
            maxLength={120}
            className="border-fio bg-paper text-ink mt-1 w-full rounded-sm border px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-[13px] font-semibold" htmlFor="nova-duracao">
            Duração (min)
          </label>
          <input
            id="nova-duracao"
            name="duracao"
            type="number"
            min={5}
            max={600}
            step={5}
            defaultValue={30}
            required
            className="border-fio bg-paper text-ink mt-1 w-24 rounded-sm border px-2 py-1.5 text-right font-mono text-sm tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[13px] font-semibold" htmlFor="novo-preco">
            Preço (R$)
          </label>
          <input
            id="novo-preco"
            name="preco"
            inputMode="decimal"
            placeholder="0,00"
            className="border-fio bg-paper text-ink mt-1 w-28 rounded-sm border px-2 py-1.5 text-right font-mono text-sm tabular-nums"
          />
        </div>
        <button
          type="submit"
          className="bg-ink text-paper rounded-pill px-4 py-2 text-sm font-semibold"
        >
          Cadastrar
        </button>
      </form>
      <p className="text-ink-2 mt-2 text-[12px]">
        Procedimento não se apaga, se inativa: consulta antiga aponta para ele, e apagar
        reescreveria o histórico e o caixa de um mês já fechado.
      </p>
    </section>
  );
}

function SoLeitura() {
  return (
    <section className="bg-paper mt-5 rounded-lg p-5">
      <p className="text-ink-2 text-sm">
        Quem é dono ou cuida do financeiro cadastra e edita os procedimentos. Você vê a lista porque
        a duração é o que a agenda reserva quando você marca.
      </p>
    </section>
  );
}
