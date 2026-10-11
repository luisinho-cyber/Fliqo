import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel } from '../../componentes/Avisos';
import { Procedimentos } from '../../componentes/Procedimentos';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { Procedimentos as Dados } from '../../lib/tipos';

/** O cadastro de procedimentos da clínica. Toda pessoa da equipe lê; dono e financeiro editam. */
export const dynamic = 'force-dynamic';

const AVISOS: Record<string, { texto: string; tom: 'ok' | 'risco' }> = {
  salvo: { texto: 'Pronto, salvo.', tom: 'ok' },
  nome_repetido: {
    texto:
      'Já existe um procedimento com esse nome nesta clínica. Se ele está inativo, reative em vez de criar outro: dois com o mesmo nome fazem o preço se perder entre os dois.',
    tom: 'risco',
  },
};

export default async function TelaProcedimentos({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="os procedimentos" />
      </main>
    );
  }
  const { ctx } = entrada;

  const q = await searchParams;
  const aviso = typeof q.aviso === 'string' ? AVISOS[q.aviso] : undefined;
  const r = await buscar<Dados>(ctx, '/api/procedimentos');

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/procedimentos" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        {aviso === undefined ? null : (
          <p
            className={
              aviso.tom === 'risco'
                ? 'border-risco bg-risco-tinta mb-5 rounded-md border px-4 py-3 text-sm'
                : 'border-ok bg-ok-tinta mb-5 rounded-md border px-4 py-3 text-sm'
            }
          >
            {aviso.texto}
          </p>
        )}
        {r.ok ? <Procedimentos dados={r.dados} /> : <Indisponivel oQue="os procedimentos" />}
      </main>
    </div>
  );
}
