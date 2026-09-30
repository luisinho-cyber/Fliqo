import Link from 'next/link';
import { Cabecalho } from '../../../componentes/Cabecalho';
import { Indisponivel, Vazio } from '../../../componentes/Avisos';
import { QualificacaoDoLead } from '../../../componentes/QualificacaoDoLead';
import { buscar, entrarNoPainel } from '../../../lib/painel';
import type { FichaDaConversa, Mensagem } from '../../../lib/tipos';
import { assumirConversa, devolverConversa } from '../../acoes';

/**
 * Uma conversa: o que o paciente escreveu, inteiro, e a ficha do lead ao lado.
 *
 * O conteúdo aparece completo aqui porque é o trabalho de quem atende. Ele não
 * vai para log, métrica nem mensagem de erro em lugar nenhum do caminho.
 */

export const dynamic = 'force-dynamic';

export default async function Conversa({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="a conversa" />
      </main>
    );
  }
  const { ctx } = entrada;

  const ficha = await buscar<FichaDaConversa>(ctx, `/api/conversas/${id}`);
  const mensagens = await buscar<Mensagem[]>(ctx, `/api/conversas/${id}/mensagens`);

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/conversas" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        <Link href="/conversas" className="text-marca text-[13px] font-semibold">
          ← Todas as conversas
        </Link>

        {!ficha.ok ? (
          <div className="mt-3">
            {ficha.motivo === 'sem_acesso' ? (
              <Vazio
                titulo="Esta conversa não é desta clínica."
                detalhe="Se você troca de clínica no topo, volte para a lista e abra de novo."
              />
            ) : (
              <Indisponivel oQue="a conversa" />
            )}
          </div>
        ) : (
          <div className="mt-3 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="bg-paper min-w-0 rounded-lg p-5">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <h1 className="truncate text-xl">{ficha.dados.paciente.nome}</h1>
                  <p className="text-ink-2 font-mono text-[13px] tabular-nums">
                    {ficha.dados.paciente.telefone}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {ficha.dados.modo === 'humano' ? (
                    <>
                      <span className="text-marca border-marca rounded-pill border px-2 py-0.5 text-[12px] font-semibold">
                        assistente parada
                      </span>
                      <form action={devolverConversa}>
                        <input type="hidden" name="conversa" value={ficha.dados.id} />
                        <button
                          type="submit"
                          className="border-fio bg-paper rounded-pill border px-3 py-1 text-[13px] font-semibold"
                        >
                          Devolver para a assistente
                        </button>
                      </form>
                    </>
                  ) : (
                    <form action={assumirConversa}>
                      <input type="hidden" name="conversa" value={ficha.dados.id} />
                      <button
                        type="submit"
                        className="bg-ink text-paper rounded-pill px-3 py-1 text-[13px] font-semibold"
                      >
                        Assumir
                      </button>
                    </form>
                  )}
                </div>
              </div>

              {ficha.dados.modo === 'humano' && (
                <p className="border-marca text-marca mb-4 rounded-md border px-3 py-2 text-[13px]">
                  Enquanto esta conversa estiver com a equipe, a assistente não responde nada aqui.
                  {ficha.dados.motivoHandover === null
                    ? ''
                    : ` Motivo: ${ficha.dados.motivoHandover}.`}
                </p>
              )}

              {!mensagens.ok ? (
                <Indisponivel oQue="as mensagens" />
              ) : mensagens.dados.length === 0 ? (
                <Vazio
                  titulo="Nenhuma mensagem ainda."
                  detalhe="As mensagens aparecem aqui assim que a conversa começar."
                />
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="mensagens">
                  {mensagens.dados.map((m) => (
                    <li
                      key={m.id}
                      className={
                        m.direction === 'entrada'
                          ? 'border-fio bg-ground max-w-[85%] self-start rounded-[12px] border px-3 py-2 text-[13px]'
                          : 'border-ok/40 bg-ok/10 max-w-[85%] self-end rounded-[12px] border px-3 py-2 text-[13px]'
                      }
                    >
                      {/* Conteúdo inteiro na tela: é o trabalho de quem atende. */}
                      <p className="whitespace-pre-line">
                        {m.body ?? `(${m.media_kind ?? 'mensagem sem texto'})`}
                      </p>
                      <span className="text-ink-2 mt-1 block font-mono text-[10px] tabular-nums">
                        {m.author === 'paciente'
                          ? 'paciente'
                          : m.author === 'ia'
                            ? 'assistente'
                            : m.author}{' '}
                        ·{' '}
                        {new Date(m.created_at).toLocaleString('pt-BR', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <QualificacaoDoLead ficha={ficha.dados} />
          </div>
        )}
      </main>
    </div>
  );
}
