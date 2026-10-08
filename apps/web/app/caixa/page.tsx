import { Cabecalho } from '../../componentes/Cabecalho';
import { Indisponivel } from '../../componentes/Avisos';
import { Caixa } from '../../componentes/Caixa';
import { buscar, entrarNoPainel } from '../../lib/painel';
import type { Caixa as Dados } from '../../lib/tipos';

/**
 * O caixa do período.
 *
 * Duas recusas diferentes, e a tela escreve frases diferentes para elas: quem não tem
 * papel para ver dinheiro, e a clínica em modo convidado, onde o caixa não existe porque
 * a verdade desses dados está no outro sistema. A segunda não é falta de permissão, e
 * dizer "acesso negado" ali seria acusar a pessoa de algo que não é com ela.
 */
export const dynamic = 'force-dynamic';

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function TelaCaixa({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-5 py-12">
        <Indisponivel oQue="o caixa" />
      </main>
    );
  }
  const { ctx } = entrada;

  const q = await searchParams;
  const janela = [
    typeof q.de === 'string' && DATA_ISO.test(q.de) ? `de=${q.de}` : '',
    typeof q.ate === 'string' && DATA_ISO.test(q.ate) ? `ate=${q.ate}` : '',
  ].filter((p) => p !== '');
  const caminho = `/api/caixa${janela.length === 0 ? '' : `?${janela.join('&')}`}`;

  const r = await buscar<Dados>(ctx, caminho);

  return (
    <div className="flex min-h-screen flex-col">
      <Cabecalho atual="/caixa" clinica={ctx.clinica} clinicas={ctx.clinicas} />
      <main className="flex-1 p-5">
        {r.ok ? (
          <Caixa dados={r.dados} />
        ) : r.motivo === 'sem_acesso' ? (
          ctx.clinica.modoConvidado ? (
            <NoOutroSistema />
          ) : (
            <SemPapel />
          )
        ) : (
          <Indisponivel oQue="o caixa" />
        )}
      </main>
    </div>
  );
}

function NoOutroSistema() {
  return (
    <section className="bg-paper rounded-lg p-5">
      <h1 className="text-xl">O caixa desta clínica vive no outro sistema.</h1>
      <p className="text-ink-2 mt-2 text-sm">
        A Fliqo está operando sobre a agenda que vocês já mantêm em outro lugar, e é lá que o
        financeiro fecha. Mostrar aqui um caixa pela metade seria pior do que não mostrar: um número
        que não bate com o outro sistema faz desconfiar dos números que estão certos.
      </p>
      <p className="text-ink-2 mt-2 text-sm">
        A agenda, a confirmação, a lista de espera e o atraso continuam funcionando normalmente.
      </p>
    </section>
  );
}

function SemPapel() {
  return (
    <section className="bg-paper rounded-lg p-5">
      <h1 className="text-xl">O caixa é de quem cuida do dinheiro da clínica.</h1>
      <p className="text-ink-2 mt-2 text-sm">
        Quem é dono ou cuida do financeiro vê esta tela. Se você precisa dela, peça a quem é dono
        para incluir o seu acesso.
      </p>
    </section>
  );
}
