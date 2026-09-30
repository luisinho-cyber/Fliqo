import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel, Vazio } from '../../componentes/Avisos';
import { SemanaArrastavel } from '../../componentes/SemanaArrastavel';
import { hhmm } from '../../lib/linha';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { Semana } from '../../lib/tipos';
import { oferecerVaga, remarcar, remarcarPorArraste } from '../acoes';

/**
 * A semana por profissional.
 *
 * Duas formas de remarcar, de propósito: arrastar o bloco, e o formulário
 * abaixo da grade. O arraste é rápido no computador da recepção; o formulário é
 * o que funciona no celular e sem JavaScript. Os dois chamam a mesma API, e é
 * o banco que decide se o horário ainda estava livre.
 */

export const dynamic = 'force-dynamic';

// O tom nunca é âmbar aqui: âmbar é este minuto ou atraso. "O horário acabou de
// ser ocupado" é remarcação que não aconteceu — isso é risco.
const AVISOS: Record<string, { texto: string; tom: 'risco' | 'ok' }> = {
  horario_ocupado: {
    texto: 'Esse horário acabou de ser ocupado. A consulta continua onde estava.',
    tom: 'risco',
  },
  oferta_enviada: {
    texto: 'Vaga oferecida para a lista de espera. Aviso quando alguém aceitar.',
    tom: 'ok',
  },
};

export default async function Agenda({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="a agenda" />
      </main>
    );
  }
  const { ctx } = entrada;

  const q = await searchParams;
  const de = typeof q.de === 'string' ? q.de : undefined;
  const aviso = typeof q.aviso === 'string' ? AVISOS[q.aviso] : undefined;

  const r = await buscar<Semana>(ctx, `/api/agenda/semana${de === undefined ? '' : `?de=${de}`}`);

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/agenda" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        <section className="bg-paper rounded-lg p-5">
          <h1 className="mb-3 text-xl">Semana</h1>

          {aviso !== undefined && (
            <p
              role="status"
              className={`mb-4 rounded-md border px-3 py-2 text-[13px] ${
                aviso.tom === 'risco' ? 'border-risco text-risco' : 'border-ok text-ok'
              }`}
            >
              {aviso.texto}
            </p>
          )}

          {!r.ok ? (
            <Indisponivel oQue="a agenda" />
          ) : r.dados.profissionais.length === 0 ? (
            <Vazio
              titulo="Nenhum profissional ativo."
              detalhe="Cadastre quem atende para a semana aparecer aqui."
            />
          ) : (
            <>
              <SemanaArrastavel
                dias={r.dados.dias}
                profissionais={r.dados.profissionais}
                fuso={r.dados.fuso}
                aoSoltar={remarcarPorArraste}
              />

              <div className="border-fio mt-5 grid gap-5 border-t pt-5 lg:grid-cols-2">
                <FormularioDeRemarcacao semana={r.dados} />
                <Vagas semana={r.dados} />
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * O mesmo que o arraste, por formulário. Funciona no toque e sem JavaScript —
 * arrastar num grid de sete colunas no celular é briga, e quem está de luva
 * precisa de um caminho que não dependa de precisão.
 */
function FormularioDeRemarcacao({ semana }: { semana: Semana }) {
  const consultas = semana.dias.flatMap((d) =>
    d.consultas
      .filter((c) => c.status !== 'cancelado' && c.status !== 'faltou')
      .map((c) => ({ ...c, dataIso: d.dataIso })),
  );

  if (consultas.length === 0) {
    return (
      <Vazio titulo="Nada marcado nesta semana." detalhe="Sem consulta, não há o que remarcar." />
    );
  }

  return (
    <form action={remarcar}>
      <h2 className="mb-2 text-base">Remarcar sem arrastar</h2>
      <label className="mb-3 block">
        <span className="text-ink-2 mb-1 block text-[13px]">Consulta</span>
        <select
          name="consulta"
          className="border-fio bg-paper text-ink w-full rounded-sm border px-2 py-1.5 text-[13px]"
        >
          {consultas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.dataIso.slice(8, 10)}/{c.dataIso.slice(5, 7)}{' '}
              {hhmm(Date.parse(c.inicioAgendado), semana.fuso)} · {c.paciente}
            </option>
          ))}
        </select>
      </label>
      <label className="mb-3 block">
        <span className="text-ink-2 mb-1 block text-[13px]">Novo horário</span>
        <input
          type="datetime-local"
          name="novoInicio"
          required
          className="border-fio bg-paper text-ink w-full rounded-sm border px-2 py-1.5 font-mono text-[13px]"
        />
      </label>
      <button
        type="submit"
        className="border-fio bg-paper rounded-pill border px-4 py-1.5 text-[13px] font-semibold"
      >
        Remarcar
      </button>
    </form>
  );
}

/** Horário livre com a única ação que ele pede: chamar quem está na fila. */
function Vagas({ semana }: { semana: Semana }) {
  const vagas = semana.dias.flatMap((d) => d.vagas.map((v) => ({ ...v, dataIso: d.dataIso })));
  const nomes = new Map(semana.profissionais.map((p) => [p.id, p.nome]));

  if (vagas.length === 0) {
    return (
      <Vazio
        titulo="Sem buraco na agenda desta semana."
        detalhe="Quando abrir um espaço entre dois atendimentos, ele aparece aqui para oferecer."
      />
    );
  }

  return (
    <div>
      <h2 className="mb-2 text-base">Horários livres</h2>
      <ul className="m-0 list-none p-0" data-testid="vagas">
        {vagas.map((v) => (
          <li
            key={`${v.profissionalId}-${v.inicio}`}
            className="border-fio flex flex-wrap items-center gap-3 border-t py-2 first:border-t-0"
          >
            <span className="font-mono text-[13px] tabular-nums">
              {v.dataIso.slice(8, 10)}/{v.dataIso.slice(5, 7)}{' '}
              {hhmm(Date.parse(v.inicio), semana.fuso)}–{hhmm(Date.parse(v.fim), semana.fuso)}
            </span>
            <span className="text-ink-2 min-w-0 flex-1 truncate text-[13px]">
              {nomes.get(v.profissionalId) ?? ''}
            </span>
            <form action={oferecerVaga}>
              <input type="hidden" name="profissionalId" value={v.profissionalId} />
              <input type="hidden" name="inicio" value={v.inicio} />
              <input type="hidden" name="fim" value={v.fim} />
              <button
                type="submit"
                className="border-fio bg-paper rounded-pill border px-3 py-1 text-[13px] font-semibold"
              >
                Oferecer à lista de espera
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
