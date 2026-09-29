import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Os caminhos que liberam um horário.
 *
 * "A vaga cancelada se preenche" é a promessa central do produto. Ela depende
 * de TODO caminho que cancela uma consulta chamar a lista de espera — e a
 * equivalência entre os caminhos existia só na cabeça de quem escreveu. Quando
 * a rota do painel entrou sem chamar a fila, nada acusou: o horário abria e
 * ninguém era avisado, justamente pelo caminho que a recepção mais usa.
 *
 * Esta é a invariante enumerada, no mesmo formato da lista SEM_FORCE e da lista
 * das funções security definer: quem libera horário está aqui pelo nome, com o
 * teste de comportamento que prova. Caminho novo aparece na varredura sozinho e
 * quebra o CI até alguém decidir, por escrito, se ele abre rodada ou não.
 *
 * A varredura é por `agenda.cancelar(`, que é a única função que muda uma
 * consulta para 'cancelado' — o quinto caminho vai ter que passar por ela.
 */

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));

interface Caminho {
  /** Arquivo, relativo à raiz do repositório. */
  arquivo: string;
  /** Quem dispara, em português de quem opera a clínica. */
  quem: string;
  /** Como aquele arquivo chama a fila. */
  chamaAFila: string;
  /** Onde está o teste de comportamento. */
  provadoEm: string;
}

/**
 * Quem CANCELA uma consulta. Todos os três precisam chamar a lista de espera:
 * o horário abriu, e alguém está esperando por ele.
 */
const CANCELAM: Caminho[] = [
  {
    arquivo: 'apps/worker/src/botao.ts',
    quem: 'o paciente cancela pelo botão do WhatsApp',
    chamaAFila: 'abrirRodada',
    provadoEm: 'apps/worker/tests/acoes.test.ts',
  },
  {
    arquivo: 'apps/worker/src/executor.ts',
    quem: 'a assistente cancela pela ferramenta cancelar_consulta',
    chamaAFila: 'abrirRodada',
    provadoEm: 'apps/worker/tests/conversa.test.ts',
  },
  {
    arquivo: 'apps/api/src/rotas/painel.ts',
    quem: 'a recepção cancela pelo painel',
    // A API não fala com o WhatsApp: ela enfileira e o worker executa.
    chamaAFila: 'FILA_OFERTA',
    provadoEm: 'apps/api/tests/painel.test.ts',
  },
];

/**
 * Quem ABRE RODADA. É um conjunto maior: `ofertas.ts` chama a fila sem cancelar
 * nada — em modo sequencial, a oferta que expirou passa para o próximo, e o
 * horário já estava aberto. Enumerado para o quinto não entrar calado.
 */
const ABREM_RODADA: string[] = [
  'apps/worker/src/botao.ts',
  'apps/worker/src/executor.ts',
  'apps/worker/src/ofertas.ts',
  'apps/worker/src/index.ts',
  'apps/api/src/rotas/painel.ts',
];

/** Os arquivos de código que a varredura olha. */
const CODIGO = [
  'apps/worker/src/botao.ts',
  'apps/worker/src/executor.ts',
  'apps/worker/src/ofertas.ts',
  'apps/worker/src/acoes.ts',
  'apps/worker/src/conversa.ts',
  'apps/worker/src/atrasos.ts',
  'apps/worker/src/resposta.ts',
  'apps/worker/src/envio.ts',
  'apps/worker/src/index.ts',
  'apps/api/src/rotas/painel.ts',
  'apps/api/src/rotas/hoje.ts',
  'apps/api/src/rotas/conversas.ts',
  'apps/api/src/rotas/conexao.ts',
  'apps/api/src/app.ts',
];

function contem(arquivo: string, agulha: string): boolean {
  try {
    return readFileSync(RAIZ + arquivo, 'utf8').includes(agulha);
  } catch {
    // Arquivo que deixou de existir não é caminho de nada.
    return false;
  }
}

/** Quantos caracteres depois do cancelamento ainda contam como "o mesmo lugar". */
const JANELA = 1_200;

/**
 * A chamada da fila tem que estar PERTO do cancelamento, não em qualquer lugar
 * do arquivo.
 *
 * `painel.ts` hospeda a rota de cancelar e a de oferecer vaga. Procurar
 * `FILA_OFERTA` no arquivo inteiro daria verde mesmo com a rota de cancelar sem
 * chamar nada — foi assim que a primeira versão deste guarda passou por uma
 * mutação que devolvia o bug original.
 */
function chamaAFilaAoCancelar(arquivo: string, agulha: string): boolean {
  let fonte: string;
  try {
    fonte = readFileSync(RAIZ + arquivo, 'utf8');
  } catch {
    return false;
  }
  let de = fonte.indexOf('agenda.cancelar(');
  while (de !== -1) {
    if (fonte.slice(de, de + JANELA).includes(agulha)) return true;
    de = fonte.indexOf('agenda.cancelar(', de + 1);
  }
  return false;
}

describe('todo caminho que cancela consulta chama a lista de espera', () => {
  it('a lista enumerada cobre exatamente quem chama agenda.cancelar', () => {
    // Arquivo novo que passe a cancelar aparece aqui e o CI para até alguém
    // decidir, por escrito, se ele abre rodada.
    const achados = CODIGO.filter((a) => contem(a, 'agenda.cancelar(')).sort();
    expect(achados).toEqual(CANCELAM.map((c) => c.arquivo).sort());
  });

  it.each(CANCELAM)('$quem chama a fila ($chamaAFila)', ({ arquivo, chamaAFila }) => {
    expect(
      chamaAFilaAoCancelar(arquivo, chamaAFila),
      `${arquivo} cancela consulta e não chama a lista de espera no mesmo lugar`,
    ).toBe(true);
  });

  it('são três caminhos de cancelamento, e o da recepção é um deles', () => {
    // O da recepção entrou depois, sem chamar a fila, e passou despercebido.
    // A contagem explícita é o lembrete de que ele existe.
    expect(CANCELAM).toHaveLength(3);
    expect(CANCELAM.map((c) => c.arquivo)).toContain('apps/api/src/rotas/painel.ts');
  });
});

describe('quem abre rodada de ofertas está enumerado', () => {
  it('a lista cobre exatamente quem chama a fila', () => {
    // Conjunto maior que o de cancelamento: ofertas.ts passa a vaga adiante sem
    // cancelar nada, e index.ts é o handler da fila que o painel enfileira.
    const achados = CODIGO.filter(
      (a) => contem(a, 'abrirRodada(') || contem(a, 'FILA_OFERTA'),
    ).sort();
    expect(achados).toEqual([...ABREM_RODADA].sort());
  });

  it('cada caminho de cancelamento diz onde o comportamento dele é provado', () => {
    // Apontar para arquivo que não existe é pior do que não apontar: parece
    // coberto e não está.
    for (const caminho of CANCELAM) {
      expect(contem(caminho.provadoEm, 'describe('), `${caminho.provadoEm} não existe`).toBe(true);
    }
  });
});
