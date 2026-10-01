import Link from 'next/link';

/** Sem menu lateral: a navegação são abas no topo (DESIGN.md). */
const ABAS = [
  { href: '/hoje', rotulo: 'Linha do dia', soDono: false },
  { href: '/conversas', rotulo: 'Conversas', soDono: false },
  { href: '/agenda', rotulo: 'Agenda', soDono: false },
  // A API nega com 403 quem não é dono. A aba não aparece para não oferecer
  // uma porta que bate na cara de quem abre.
  { href: '/pontualidade', rotulo: 'Pontualidade', soDono: true },
  { href: '/configuracoes/whatsapp', rotulo: 'WhatsApp', soDono: true },
] as const;

export function Abas({ atual, ehDono }: { atual: string; ehDono: boolean }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Seções do painel">
      {ABAS.filter((a) => !a.soDono || ehDono).map((a) => {
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
