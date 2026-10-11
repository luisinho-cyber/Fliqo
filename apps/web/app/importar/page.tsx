import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel, Vazio } from '../../componentes/Avisos';
import { ImportarAgenda } from '../../componentes/ImportarAgenda';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { Importacoes } from '../../lib/tipos';

/**
 * Importar a agenda do sistema que a clínica já usa.
 *
 * A tela existe só no modo convidado, e isso é afirmação sobre onde está a verdade:
 * clínica que marca na Fliqo não importa agenda de ninguém. Quem decide é a API, que
 * nega 403 a quem não é dono; a aba só não é oferecida.
 */
export const dynamic = 'force-dynamic';

export default async function TelaImportar() {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="a importação de agenda" />
      </main>
    );
  }
  const { ctx } = entrada;
  const feitas = await buscar<Importacoes>(ctx, '/api/importacoes');

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/importar" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        <section className="bg-paper rounded-lg p-5">
          <h1 className="text-xl">Importar agenda</h1>
          {ctx.clinica.modoConvidado ? (
            <p className="text-ink-2 mt-1 text-sm">
              A agenda desta clínica vive em outro sistema. A Fliqo lê a exportação dele e passa a
              confirmar, chamar a lista de espera e avisar atraso sobre essas consultas — sem
              substituir nada.
            </p>
          ) : (
            <p className="text-ink-2 mt-1 text-sm">
              Esta clínica marca direto na Fliqo, então não há agenda de outro sistema para
              importar. Se isso mudou, fale com quem cuida do sistema para ligar o modo convidado.
            </p>
          )}

          <div className="mt-5">
            <ImportarAgenda />
          </div>
        </section>

        <section className="bg-paper mt-5 rounded-lg p-5">
          <h2 className="text-base">Importações anteriores</h2>
          {!feitas.ok ? (
            <div className="mt-3">
              {feitas.motivo === 'sem_acesso' ? (
                <Vazio
                  titulo="Só quem é dono vê o histórico de importações."
                  detalhe="Ele mostra quem importou o quê e quando, e é por isso que fica com o dono da clínica."
                />
              ) : (
                <Indisponivel oQue="o histórico de importações" />
              )}
            </div>
          ) : feitas.dados.importacoes.length === 0 ? (
            <div className="mt-3">
              <Vazio
                titulo="Nenhuma agenda importada ainda."
                detalhe="Depois da primeira importação, cada uma aparece aqui com quantas linhas entraram e quantas ficaram de fora."
              />
            </div>
          ) : (
            <ul className="mt-3">
              {feitas.dados.importacoes.map((i) => (
                <li
                  key={i.id}
                  className="border-fio flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2 text-sm last:border-b-0"
                >
                  <span className="font-mono">{quando(i.em, feitas.dados.fuso)}</span>
                  <span className="min-w-[160px] flex-1 font-semibold">{i.arquivo}</span>
                  <span className="text-ink-2">
                    <span className="font-mono">{i.entraram}</span> entraram,{' '}
                    <span className="font-mono">{i.repetidas}</span> repetidas,{' '}
                    <span className="font-mono">{i.recusadas}</span> recusadas
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

/** Data e hora no fuso da clínica, e não no de quem abriu a tela. */
function quando(iso: string, fuso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
