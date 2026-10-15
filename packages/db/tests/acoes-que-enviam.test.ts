import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ACOES_QUE_ENVIAM, ACOES_QUE_NAO_ENVIAM, STATUS_DE_ACAO } from '../src/schema';
import { ownerPool, resetDatabase } from './helpers';

/**
 * As duas invariantes que impedem a próxima "porta ao lado".
 *
 * A exclusão no claim é por PROPRIEDADE — quem envia mensagem —, não por nome caso
 * a caso. A primeira versão da regra excluía `expirar_oferta` olhando o nome, e o
 * nome engana: expirar não depende do WhatsApp, mas passar a vaga adiante manda
 * mensagem. Classificar por propriedade só funciona se tipo NOVO não puder entrar
 * sem alguém decidir, e é isso que estes testes garantem.
 */
let owner: pg.Pool;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
}, 60_000);

afterAll(async () => {
  await owner.end();
});

describe('quem envia mensagem', () => {
  /** Invariante 1: nada fica sem classificação. */
  it('a união das duas listas é exatamente a enum do banco', async () => {
    const { rows } = await owner.query<{ valor: string }>(
      `select e.enumlabel as valor
         from pg_enum e join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'app' and t.typname = 'action_kind'`,
    );
    const naEnum = rows.map((l) => l.valor).sort();
    const classificados = [...ACOES_QUE_ENVIAM, ...ACOES_QUE_NAO_ENVIAM].sort();

    expect(
      classificados,
      'tipo de ação novo tem de entrar numa das duas listas: sem isso ele decide sozinho o que faz numa queda',
    ).toEqual(naEnum);
  });

  it('nenhum tipo está nas duas listas', () => {
    const nos_dois = ACOES_QUE_ENVIAM.filter((k) =>
      (ACOES_QUE_NAO_ENVIAM as readonly string[]).includes(k),
    );
    expect(nos_dois).toEqual([]);
  });

  /**
   * Invariante 2: o banco e o código não discordam de quem envia.
   *
   * O teste PERGUNTA a propriedade ao banco para cada valor, em vez de confiar na
   * lista do código. Divergir não quebraria no start: quebraria numa queda, com
   * uma ação sendo consumida quando devia esperar.
   */
  it('o veredito do banco coincide com a lista do código, valor por valor', async () => {
    const { rows } = await owner.query<{ valor: string; envia: boolean }>(
      `select e.enumlabel as valor, app.action_kind_envia(e.enumlabel::app.action_kind) as envia
         from pg_enum e join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'app' and t.typname = 'action_kind'
        order by e.enumsortorder`,
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const { valor, envia } of rows) {
      const noCodigo = (ACOES_QUE_ENVIAM as readonly string[]).includes(valor);
      expect(envia, `o banco e o código discordam sobre "${valor}"`).toBe(noCodigo);
    }
  });

  /**
   * O padrão inseguro é o seguro: valor que a função não conhece devolve "envia",
   * ou seja, é SEGURADO durante a queda. Segurar uma ação é recuperável; queimá-la
   * não é. O CI falha alto antes de o tipo novo chegar à produção, e se chegar, ele
   * erra para o lado que não perde confirmação.
   */
  it('valor conhecido é tratado como "envia"', async () => {
    // Um valor que existe na enum e NÃO está na lista de exceções da função.
    const { rows } = await owner.query<{ envia: boolean }>(
      `select app.action_kind_envia('confirmacao') as envia`,
    );
    expect(rows[0]?.envia).toBe(true);

    // E a função é imutável: o planejador pode usá-la em índice e em predicado
    // sem reavaliar por linha.
    const { rows: prop } = await owner.query<{ volatil: string }>(
      `select provolatile as volatil from pg_proc
        where proname = 'action_kind_envia'
          and pronamespace = 'app'::regnamespace`,
    );
    expect(prop[0]?.volatil, 'action_kind_envia devia ser immutable').toBe('i');
  });

  /**
   * O padrão seguro, testado com um valor que a função REALMENTE não conhece.
   *
   * Sem criar o valor, nenhum teste distingue `not in ('marcar_risco')` de uma
   * lista de permissão `in ('confirmacao', ...)`: as duas concordam sobre todos os
   * valores que existem hoje. A diferença aparece só no dia em que alguém
   * acrescenta um tipo — e é justamente esse dia que precisa errar para o lado
   * seguro. Fica por último no arquivo porque acrescenta valor à enum.
   */
  it('tipo de ação que a função não conhece é tratado como "envia"', async () => {
    await owner.query(`alter type app.action_kind add value 'tipo_inventado'`);
    const { rows } = await owner.query<{ envia: boolean }>(
      `select app.action_kind_envia('tipo_inventado') as envia`,
    );
    expect(
      rows[0]?.envia,
      'tipo novo tem de ser SEGURADO durante a queda: segurar é recuperável, queimar não',
    ).toBe(true);
  });
});

/**
 * A guarda do status novo.
 *
 * Status que nenhuma consulta enumera é pior do que ação falhada: falhada aparece
 * em algum lugar, e a que ninguém enumera não aparece em nenhum. Uma queda de três
 * horas comeria um dia de confirmação e o status novo só esconderia isso de forma
 * mais educada.
 */
describe('todo status de ação está declarado', () => {
  /**
   * O que cada status significa para quem lê a tabela. Três perguntas, porque são
   * as três que mudam comportamento: o claim reclama? é fim de linha? conta como
   * falha (e portanto alerta)?
   */
  const PAPEL: Record<string, { reclamavel: boolean; terminal: boolean; ehFalha: boolean }> = {
    pendente: { reclamavel: true, terminal: false, ehFalha: false },
    executando: { reclamavel: false, terminal: false, ehFalha: false },
    feito: { reclamavel: false, terminal: true, ehFalha: false },
    cancelado: { reclamavel: false, terminal: true, ehFalha: false },
    erro: { reclamavel: false, terminal: true, ehFalha: true },
    // Terminal e NÃO falha: a queda venceu a mensagem, e isso é consequência
    // esperada. Alerta aqui ensinaria a recepção a ignorar alerta.
    sem_proposito: { reclamavel: false, terminal: true, ehFalha: false },
  };

  it('os valores do check estão todos declarados, e nada sobra', async () => {
    const { rows } = await owner.query<{ definicao: string }>(
      `select pg_get_constraintdef(oid) as definicao from pg_constraint
        where conname = 'scheduled_actions_status_check'`,
    );
    expect(rows, 'o check de status não existe').toHaveLength(1);

    const noBanco = [...(rows[0]?.definicao.matchAll(/'([a-z_]+)'/g) ?? [])]
      .map((m) => m[1] ?? '')
      .sort();

    expect(noBanco, 'STATUS_DE_ACAO divergiu do check').toEqual([...STATUS_DE_ACAO].sort());
    expect(Object.keys(PAPEL).sort(), 'status novo sem papel declarado').toEqual(noBanco);
  });

  it('só `pendente` é reclamável, e só `erro` conta como falha', () => {
    // Estas duas afirmações são o que o claim e o alerta fazem de verdade. Se
    // alguém acrescentar um segundo status reclamável, esta linha obriga a pensar.
    expect(
      Object.entries(PAPEL)
        .filter(([, p]) => p.reclamavel)
        .map(([n]) => n),
    ).toEqual(['pendente']);
    expect(
      Object.entries(PAPEL)
        .filter(([, p]) => p.ehFalha)
        .map(([n]) => n),
    ).toEqual(['erro']);
  });

  it('`sem_proposito` é terminal, não reclamável e não é falha', () => {
    expect(PAPEL.sem_proposito).toEqual({ reclamavel: false, terminal: true, ehFalha: false });
  });
});
