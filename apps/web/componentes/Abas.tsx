import Link from 'next/link';

/** Sem menu lateral: a navegação são abas no topo (DESIGN.md). */
const ABAS = [
  { href: '/hoje', rotulo: 'Linha do dia' },
  { href: '/conversas', rotulo: 'Conversas' },
  { href: '/agenda', rotulo: 'Agenda' },
] as const;

export function Abas({ atual }: { atual: string }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Seções do painel">
      {ABAS.map((a) => {
        const aqui = a.href === atual;
        return (
          <Link
            key={a.href}
            href={a.href}
            aria-current={aqui ? 'page' : undefined}
            className={
              aqui
                ? 'bg-ink text-paper rounded-full px-3.5 py-1.5 font-semibold'
                : 'border-linha-forte text-ink-suave hover:text-ink rounded-full border border-transparent px-3.5 py-1.5 font-semibold hover:border-current'
            }
          >
            {a.rotulo}
          </Link>
        );
      })}
    </nav>
  );
}
