import { describe, expect, it } from 'vitest';
import { RECURSOS_DO_MODO_PROPRIO } from '@fliqo/core';
import { abasVisiveis } from '../componentes/Abas';
import type { PapelNaClinica } from '../lib/tipos';

/**
 * Quem vê qual aba.
 *
 * Este arquivo existe por uma pergunta que faltava: a API nega 403 à recepção no `/api/caixa`
 * e há teste disso — mas a aba? Papel e recurso são DUAS guardas diferentes, e passar numa
 * não é passar na outra. Aba que aparece e dá erro ao clicar é pior do que aba que não
 * aparece: a primeira ensina que o sistema está quebrado, a segunda ensina o que ele faz.
 *
 * A decisão é testada como função pura. A alternativa seria render com biblioteca nova, que
 * custaria uma dependência para conferir um `filter`.
 */

const PAPEIS: readonly PapelNaClinica[] = ['dono', 'recepcao', 'profissional', 'financeiro'];

function hrefs(papel: PapelNaClinica, modoConvidado = false): string[] {
  return abasVisiveis(papel, modoConvidado).map((a) => a.href);
}

describe('a guarda de PAPEL', () => {
  it('a dona vê o caixa', () => {
    expect(hrefs('dono')).toContain('/caixa');
  });

  it('quem cuida do financeiro vê o caixa', () => {
    expect(hrefs('financeiro')).toContain('/caixa');
  });

  /** O par do 403 que a rota já devolve: a recepção não vê o faturamento da clínica. */
  it('a recepção NÃO vê a aba do caixa, em clínica de modo próprio', () => {
    expect(
      hrefs('recepcao', false),
      'a aba aparece para quem a rota nega: clicar dá erro',
    ).not.toContain('/caixa');
  });

  it('o profissional também não', () => {
    expect(hrefs('profissional')).not.toContain('/caixa');
  });

  it('o que é de dono só aparece para o dono', () => {
    for (const papel of PAPEIS.filter((p) => p !== 'dono')) {
      expect(hrefs(papel), `${papel} vê a pontualidade`).not.toContain('/pontualidade');
      expect(hrefs(papel, true), `${papel} vê a importação`).not.toContain('/importar');
      expect(hrefs(papel)).not.toContain('/configuracoes/whatsapp');
    }
  });

  it('todo papel vê a agenda, as conversas e a linha do dia', () => {
    // É o que a Fliqo faz em qualquer modo e para qualquer papel.
    for (const papel of PAPEIS) {
      expect(hrefs(papel)).toContain('/hoje');
      expect(hrefs(papel)).toContain('/conversas');
      expect(hrefs(papel)).toContain('/agenda');
    }
  });
});

describe('a guarda de RECURSO é outra', () => {
  it('em modo convidado, nem a dona vê o caixa', () => {
    // Não é questão de papel: a verdade desses dados está no outro sistema.
    expect(hrefs('dono', true)).not.toContain('/caixa');
    expect(hrefs('financeiro', true)).not.toContain('/caixa');
  });

  it('e em modo próprio a dona vê de novo', () => {
    expect(hrefs('dono', false)).toContain('/caixa');
  });

  /**
   * As duas guardas são independentes, e a tabela abaixo é o que isso significa: quatro
   * combinações, quatro respostas. Uma guarda sozinha deixaria duas delas erradas.
   */
  it.each([
    ['dono', false, true],
    ['dono', true, false],
    ['recepcao', false, false],
    ['recepcao', true, false],
  ] as const)('caixa para %s em modo convidado=%s é %s', (papel, convidado, aparece) => {
    expect(hrefs(papel, convidado).includes('/caixa')).toBe(aparece);
  });

  it('a importação de agenda é o inverso: só no modo convidado', () => {
    expect(hrefs('dono', true)).toContain('/importar');
    expect(hrefs('dono', false)).not.toContain('/importar');
  });
});

describe('toda aba de recurso está ligada à lista do core', () => {
  /**
   * A amarra que impede a próxima tela de nascer aberta: se uma aba declarar um recurso que
   * a lista do modo convidado não conhece, ela passaria o filtro sem nunca ser escondida.
   */
  it('o recurso declarado em cada aba existe em RECURSOS_DO_MODO_PROPRIO', () => {
    for (const aba of abasVisiveis('dono', false)) {
      if (aba.recurso === null) continue;
      expect(
        RECURSOS_DO_MODO_PROPRIO,
        `${aba.href} declara o recurso "${aba.recurso}", que a lista do core não conhece`,
      ).toContain(aba.recurso);
    }
  });

  it('o caixa está amarrado ao recurso financeiro, e não só ao papel', () => {
    const caixa = abasVisiveis('dono', false).find((a) => a.href === '/caixa');
    expect(caixa?.recurso, 'o caixa deixou de declarar recurso: só o papel o esconderia').toBe(
      'financeiro',
    );
  });
});
