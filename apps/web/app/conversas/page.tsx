import Link from 'next/link';
import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel, Vazio } from '../../componentes/Avisos';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { ItemDaCaixa } from '../../lib/tipos';

/**
 * A caixa de entrada da clínica.
 *
 * Conversa em modo humano vem em cima, com marcação visível: a assistente já
 * calou ali, e se ninguém responder, ninguém responde. O telefone aparece
 * mascarado porque esta tela fica aberta no balcão; o número inteiro só na
 * ficha, que alguém abriu de propósito.
 */

export const dynamic = 'force-dynamic';

const ESTADOS = [
  { valor: 'todas', rotulo: 'Todas' },
  { valor: 'humano', rotulo: 'Com a equipe' },
  { valor: 'assistente', rotulo: 'Com a assistente' },
] as const;

export default async function Conversas({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="as conversas" />
      </main>
    );
  }
  const { ctx } = entrada;

  const q = await searchParams;
  const pedido = typeof q.estado === 'string' ? q.estado : 'todas';
  const estado = ESTADOS.some((e) => e.valor === pedido) ? pedido : 'todas';

  const r = await buscar<ItemDaCaixa[]>(ctx, `/api/conversas?estado=${estado}`);

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/conversas" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        <section className="bg-paper border-linha mx-auto max-w-[860px] rounded-[16px] border p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-xl">Conversas</h1>
            <div className="flex gap-1">
              {ESTADOS.map((e) => (
                <Link
                  key={e.valor}
                  href={`/conversas?estado=${e.valor}`}
                  aria-current={e.valor === estado ? 'true' : undefined}
                  className={
                    e.valor === estado
                      ? 'bg-ink text-paper rounded-full px-3 py-1 text-[13px] font-semibold'
                      : 'border-linha-forte text-ink-suave rounded-full border px-3 py-1 text-[13px] font-semibold'
                  }
                >
                  {e.rotulo}
                </Link>
              ))}
            </div>
          </div>

          {!r.ok ? (
            <Indisponivel oQue="as conversas" />
          ) : r.dados.length === 0 ? (
            <Vazio
              titulo="Nenhuma conversa por aqui."
              detalhe="Quando alguém escrever para o WhatsApp da clínica, a conversa aparece nesta lista."
            />
          ) : (
            <ul className="m-0 list-none p-0" data-testid="caixa-de-entrada">
              {r.dados.map((c) => (
                <li key={c.id} className="border-linha border-t first:border-t-0">
                  <Link href={`/conversas/${c.id}`} className="block py-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <b>{c.paciente}</b>
                      <span className="text-ink-suave font-mono text-[12px] tabular-nums">
                        {c.telefoneMascarado}
                      </span>
                      {c.modo === 'humano' && (
                        // A marcação é o ponto: quem olha a lista precisa ver
                        // que ali a assistente não vai responder.
                        <span className="text-late border-late rounded-full border px-2 text-[12px] font-bold">
                          assistente parada
                        </span>
                      )}
                      {!c.temConsentimento && (
                        <span className="text-ink-suave text-[12px]">sem consentimento</span>
                      )}
                      <span className="text-ink-suave ml-auto font-mono text-[12px] tabular-nums">
                        {c.ultimaEntradaEm === null
                          ? ''
                          : new Date(c.ultimaEntradaEm).toLocaleString('pt-BR', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                      </span>
                    </div>
                    {c.ultimaMensagem?.corpo != null && (
                      <p className="text-ink-suave mt-1 truncate text-[13px]">
                        {c.ultimaMensagem.autor === 'paciente' ? '' : 'você: '}
                        {c.ultimaMensagem.corpo}
                      </p>
                    )}
                    {c.modo === 'humano' && c.motivoHandover !== null && (
                      <p className="text-late mt-1 text-[12px]">{c.motivoHandover}</p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
