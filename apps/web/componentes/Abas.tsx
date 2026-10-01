import Link from 'next/link';
import { recursoLiberado, type RecursoDoModoProprio } from '@fliqo/core';
import type { PapelNaClinica } from '../lib/tipos';

/**
 * Sem menu lateral: a navegação são abas no topo (DESIGN.md).
 *
 * Cada aba declara três coisas, e cada uma esconde por um motivo diferente:
 *
 * - `papeis`: quem a API deixa entrar. `null` é todo mundo. Aba que leva a 403 é
 *   promessa quebrada, então ela não aparece para quem vai levar.
 * - `recurso`: a aba pertence a um recurso que o modo convidado DESLIGA. A lista é a
 *   mesma `RECURSOS_DO_MODO_PROPRIO` do core, e quem nega de verdade é `comRecurso` na
 *   API — isto aqui é só não oferecer.
 * - `soConvidado`: o contrário. Importar agenda só existe para a clínica cuja agenda
 *   vive em outro sistema.
 */
export interface Aba {
  href: string;
  rotulo: string;
  papeis: readonly PapelNaClinica[] | null;
  recurso: RecursoDoModoProprio | null;
  soConvidado: boolean;
}

const SO_DONO: readonly PapelNaClinica[] = ['dono'];
/** O caixa também é do financeiro. A recepção não vê o faturamento da clínica. */
const DINHEIRO: readonly PapelNaClinica[] = ['dono', 'financeiro'];

const ABAS: readonly Aba[] = [
  { href: '/hoje', rotulo: 'Linha do dia', papeis: null, recurso: null, soConvidado: false },
  { href: '/conversas', rotulo: 'Conversas', papeis: null, recurso: null, soConvidado: false },
  { href: '/agenda', rotulo: 'Agenda', papeis: null, recurso: null, soConvidado: false },
  { href: '/caixa', rotulo: 'Caixa', papeis: DINHEIRO, recurso: 'financeiro', soConvidado: false },
  {
    href: '/pontualidade',
    rotulo: 'Pontualidade',
    papeis: SO_DONO,
    recurso: null,
    soConvidado: false,
  },
  {
    href: '/importar',
    rotulo: 'Importar agenda',
    papeis: SO_DONO,
    recurso: null,
    soConvidado: true,
  },
  {
    href: '/configuracoes/whatsapp',
    rotulo: 'WhatsApp',
    papeis: SO_DONO,
    recurso: null,
    soConvidado: false,
  },
];

/**
 * Quais abas essa pessoa vê, nessa clínica. É a DECISÃO, separada do desenho.
 *
 * Exportada porque é ela que tem teste: papel e recurso são duas guardas diferentes, e
 * passar numa não é passar na outra. A API negar 403 à recepção não impede a aba de
 * aparecer — e aba que aparece e dá erro ao clicar é pior do que aba que não aparece,
 * porque ensina que a tela está quebrada em vez de ensinar o que ela pode fazer.
 */
export function abasVisiveis(papel: PapelNaClinica, modoConvidado: boolean): readonly Aba[] {
  return ABAS.filter((a) => a.papeis === null || a.papeis.includes(papel))
    .filter((a) => a.recurso === null || recursoLiberado(a.recurso, { modoConvidado }))
    .filter((a) => !a.soConvidado || modoConvidado);
}

export function Abas({
  atual,
  papel,
  modoConvidado = false,
}: {
  atual: string;
  papel: PapelNaClinica;
  modoConvidado?: boolean;
}) {
  const visiveis = abasVisiveis(papel, modoConvidado);

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
