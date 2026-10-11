import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel } from '../../componentes/Avisos';
import { Pontualidade } from '../../componentes/Pontualidade';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { Pontualidade as Dados } from '../../lib/tipos';

/**
 * A tela da pontualidade. Só o dono: a API nega 403 a todos os outros, e a aba não
 * aparece para eles — porta que bate na cara de quem abre não se oferece.
 */
export const dynamic = 'force-dynamic';

const AVISOS: Record<string, string> = {
  medida_mudou:
    'A medida mudou entre você abrir a tela e clicar: entraram atendimentos novos, e a sugestão não vale mais. A lista abaixo já está atualizada.',
};

export default async function TelaPontualidade({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="a pontualidade" />
      </main>
    );
  }
  const { ctx } = entrada;

  const q = await searchParams;
  const aviso = typeof q.aviso === 'string' ? AVISOS[q.aviso] : undefined;

  const r = await buscar<Dados>(ctx, '/api/pontualidade');

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/pontualidade" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        {aviso === undefined ? null : (
          <p className="border-fio bg-paper mb-5 rounded-md border px-4 py-3 text-sm">{aviso}</p>
        )}
        {r.ok ? (
          <Pontualidade dados={r.dados} />
        ) : r.motivo === 'sem_acesso' ? (
          <section className="bg-paper rounded-lg p-5">
            <h1 className="text-xl">Esta tela é de quem é dono da clínica.</h1>
            <p className="text-ink-2 mt-2 text-sm">
              A pontualidade compara o desempenho das pessoas da equipe pelo nome, e a única ação
              que ela oferece muda o cadastro de procedimento. Se você precisa vê-la, peça a quem é
              dono.
            </p>
          </section>
        ) : (
          <Indisponivel oQue="a pontualidade" />
        )}
      </main>
    </div>
  );
}
