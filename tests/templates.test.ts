import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '@fliqo/whatsapp';

/**
 * O contrato entre o código e o documento que alguém lê para submeter na Meta.
 *
 * O risco é o mesmo das variáveis de ambiente, um nível acima: o nome do template vive no
 * código, o nome aprovado vive na Meta, e `docs/TEMPLATES.md` é o papel que liga os dois.
 * Nenhum teste alcança a Meta — mas se o documento divergir do código, a pessoa submete o
 * nome errado e descobre com a clínica esperando a confirmação.
 *
 * Então o teste garante a única metade que dá para garantir: o documento descreve o código
 * de hoje. A outra metade é o aviso em negrito no topo dele.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DOC = readFileSync(`${RAIZ}docs/TEMPLATES.md`, 'utf8');

/**
 * O documento com o espaço em branco normalizado, para procurar FRASE.
 *
 * O prettier reflui o markdown, então uma frase de aviso pode nascer numa linha e amanhecer
 * quebrada em duas, com `>` de citação no meio. Procurar a frase no texto cru passaria a
 * falhar por formatação, e guarda que falha sem motivo é guarda que alguém desliga.
 */
const FRASES = DOC.replace(/\n>?\s*/g, ' ').replace(/\s+/g, ' ');

interface LinhaDaTabela {
  nome: string;
  categoria: string;
  variaveis: number;
  botoes: number;
}

/** A tabela-resumo do documento, lida como dado. */
function tabelaDoDoc(): LinhaDaTabela[] {
  const titulo = '## Os cinco nomes que o código referencia';
  const de = DOC.indexOf(titulo);
  expect(de, 'a tabela-resumo sumiu do TEMPLATES.md').toBeGreaterThan(0);
  const resto = DOC.slice(de + titulo.length);
  const fim = resto.indexOf('\n---');
  const secao = fim === -1 ? resto : resto.slice(0, fim);

  const linhas: LinhaDaTabela[] = [];
  for (const linha of secao.split('\n')) {
    const celulas = linha.split('|').map((c) => c.trim());
    const nome = /^`([a-z_]+)`$/.exec(celulas[1] ?? '')?.[1];
    if (nome === undefined) continue;
    linhas.push({
      nome,
      categoria: celulas[2] ?? '',
      variaveis: Number(celulas[3]),
      botoes: Number(celulas[4]),
    });
  }
  return linhas;
}

const DECLARADOS = Object.values(TEMPLATES);

/**
 * A seção de um template no documento, achada pelo NOME e não pela numeração: o título é
 * `## 3. \`oferta_de_vaga\``, e um teste que dependa do número quebra quando alguém
 * reordena as seções — o que não é erro nenhum.
 */
function secaoDoTemplate(nome: string): string | undefined {
  const titulo = new RegExp(`^## (?:\\d+\\. )?\`${nome}\`\\s*$`, 'm');
  const achado = titulo.exec(DOC);
  if (achado === null) return undefined;
  const resto = DOC.slice(achado.index);
  const fim = resto.indexOf('\n---');
  return fim === -1 ? resto : resto.slice(0, fim);
}

describe('o documento descreve o código', () => {
  const tabela = tabelaDoDoc();

  it('a tabela lista exatamente os templates que o código tem', () => {
    expect(tabela.map((l) => l.nome).sort()).toEqual(DECLARADOS.map((t) => t.nome).sort());
  });

  /**
   * A contagem de variáveis é o que mais importa depois do nome, e pelo mesmo motivo:
   * template aprovado com um `{{1}}` que o código não manda faz a Meta recusar o envio
   * inteiro, com o mesmo sintoma e na mesma hora ruim.
   */
  it.each(DECLARADOS)('o doc diz a contagem certa de variáveis de $nome', (template) => {
    const linha = tabela.find((l) => l.nome === template.nome);
    expect(linha?.variaveis, `${template.nome} tem contagem errada no doc`).toBe(
      template.variaveis,
    );
  });

  it.each(DECLARADOS)('o doc diz a contagem certa de botões de $nome', (template) => {
    const linha = tabela.find((l) => l.nome === template.nome);
    expect(linha?.botoes).toBe(template.botoes.length);
  });

  it('toda categoria declarada é uma das duas que a Meta aceita', () => {
    for (const linha of tabela) {
      expect(['utility', 'marketing'], `${linha.nome} tem categoria inválida`).toContain(
        linha.categoria,
      );
    }
  });
});

describe('cada template tem a seção com o corpo para submeter', () => {
  it.each(DECLARADOS)('$nome tem seção própria', (template) => {
    expect(
      secaoDoTemplate(template.nome),
      `${template.nome} não tem seção no documento`,
    ).toBeDefined();
  });

  /**
   * O corpo escrito no doc tem de ter os mesmos `{{n}}` que o código manda. Esta é a única
   * conferência que pega o texto de verdade: a tabela pode dizer 2 e o corpo trazer 3.
   */
  it.each(DECLARADOS)('o corpo de $nome tem os {{n}} que o código manda', (template) => {
    const secao = secaoDoTemplate(template.nome) ?? '';
    const encontradas = new Set([...secao.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
    const esperadas = new Set(Array.from({ length: template.variaveis }, (_, i) => i + 1));
    expect(
      [...encontradas].sort(),
      `o corpo de ${template.nome} não casa com as ${String(template.variaveis)} variáveis do código`,
    ).toEqual([...esperadas].sort());
  });

  /** Todo payload que o código manda tem de aparecer na tabela de botões da seção. */
  it.each(DECLARADOS.filter((t) => t.botoes.length > 0))(
    'os payloads de $nome estão na seção',
    (template) => {
      const secao = secaoDoTemplate(template.nome) ?? '';

      // Na ORDEM: o payload vai por índice, e a seção é o que a pessoa copia.
      const posicoes = template.botoes.map((p) => secao.indexOf(p));
      for (const [i, pos] of posicoes.entries()) {
        expect(pos, `o payload ${template.botoes[i] ?? ''} não aparece na seção`).toBeGreaterThan(
          0,
        );
      }
      expect(
        [...posicoes].sort((a, b) => a - b),
        `os botões de ${template.nome} estão em ordem diferente da do código`,
      ).toEqual(posicoes);
    },
  );
});

describe('os avisos que o documento existe para dar', () => {
  it('avisa que o nome tem de ser idêntico, caractere por caractere', () => {
    expect(FRASES).toMatch(/caractere por caractere/);
  });

  it('avisa que a ordem dos botões também tem de bater', () => {
    // Divergência silenciosa: o paciente toca num botão e o sistema entende outro.
    expect(FRASES).toMatch(/ORDEM dos botões/);
  });

  it('declara o idioma, que é o mesmo em todo envio', () => {
    expect(DOC).toContain('pt_BR');
  });

  /**
   * As regras de conteúdo da Meta, conferidas no texto que escrevemos. São as que fazem
   * reprovar, e reprovação custa uma rodada de revisão inteira.
   */
  it('nenhum corpo tem expressão que reprova', () => {
    const proibidas = [/clique aqui/i, /promoç[ãa]o/i, /imperd[ií]vel/i, /aproveite/i, /desconto/i];
    for (const padrao of proibidas) {
      expect(FRASES, `o texto usa "${padrao.source}", que reprova em utility`).not.toMatch(padrao);
    }
  });

  it('nenhum corpo começa nem termina com variável', () => {
    // Regra da Meta, e ela reprova por isso.
    for (const bloco of DOC.matchAll(/```\n([\s\S]*?)```/g)) {
      const corpo = (bloco[1] ?? '').trim();
      if (!corpo.includes('{{')) continue;
      expect(corpo.startsWith('{{'), 'corpo começando com variável').toBe(false);
      expect(corpo.endsWith('}}'), 'corpo terminando com variável').toBe(false);
    }
  });

  /** Quick reply da Meta corta em 25 caracteres. Texto cortado vira botão ilegível. */
  it('todo texto de botão cabe em 25 caracteres', () => {
    for (const linha of DOC.split('\n')) {
      const celulas = linha.split('|').map((c) => c.trim());
      // Linhas das tabelas de botão: | # | `Texto` | `PAYLOAD` |
      if (celulas.length !== 5 || !/^\d$/.test(celulas[1] ?? '')) continue;
      const texto = /^`(.+)`$/.exec(celulas[2] ?? '')?.[1];
      if (texto === undefined) continue;
      expect(texto.length, `o botão "${texto}" passa de 25 caracteres`).toBeLessThanOrEqual(25);
    }
  });
});
