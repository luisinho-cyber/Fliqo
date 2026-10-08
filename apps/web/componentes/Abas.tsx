import Link from 'next/link';

/**
 * Sem menu lateral: a navegação são abas no topo (DESIGN.md).
 *
 * `soConvidado` existe para a importação de agenda: ela só faz sentido na clínica
 * cuja agenda vive em outro sistema. O inverso — aba que o modo convidado DESLIGA —
 * ainda não tem ocupante: prontuário e financeiro não existem como tela hoje, e a
 * lista que vai barrá-los quando existirem é `RECURSOS_DO_MODO_PROPRIO`, no core,
 * com a guarda `comRecurso` na API. Aqui a aba nasce coberta no dia em que nascer.
 */
const ABAS = [
  { href: '/hoje', rotulo: 'Linha do dia', soDono: false, soConvidado: false },
  { href: '/conversas', rotulo: 'Conversas', soDono: false, soConvidado: false },
  { href: '/agenda', rotulo: 'Agenda', soDono: false, soConvidado: false },
  // A API nega com 403 quem não é dono. A aba não aparece para não oferecer
  // uma porta que bate na cara de quem abre.
  { href: '/importar', rotulo: 'Importar agenda', soDono: true, soConvidado: true },
  { href: '/configuracoes/whatsapp', rotulo: 'WhatsApp', soDono: true, soConvidado: false },
] as const;

export function Abas({
  atual,
  ehDono,
  modoConvidado = false,
}: {
  atual: string;
  ehDono: boolean;
  modoConvidado?: boolean;
}) {
  const visiveis = ABAS.filter((a) => !a.soDono || ehDono).filter(
    (a) => !a.soConvidado || modoConvidado,
  );

  return (
    <nav className="flex flex-wrap gap-1" aria-label="Seções do painel">
      {visiveis.map((a) => {
        const aqui = a.href === atual;
        return (
          <Link
            key={a.href}
            href={a.href}
            aria-current={aqui ? 'page' : undefined}
            className={
              aqui
                ? 'bg-ink text-paper rounded-pill px-3.5 py-1.5 font-semibold'
                : 'border-fio text-ink-2 hover:text-ink rounded-pill border border-transparent px-3.5 py-1.5 font-semibold hover:border-current'
            }
          >
            {a.rotulo}
          </Link>
        );
      })}
    </nav>
  );
}
