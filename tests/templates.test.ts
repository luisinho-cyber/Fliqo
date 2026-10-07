import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODIGOS_TRATADOS, corpoParaMeta, todasAsDefinicoes } from '@fliqo/whatsapp';

/**
 * O contrato entre o código e o documento que alguém lê para submeter na Meta.
 *
 * O risco é o mesmo das variáveis de ambiente, um nível acima: o nome do template vive no
 * código, o nome aprovado vive na Meta, e `docs/TEMPLATES.md` é o papel que liga os dois.
 * Nenhum teste alcança a Meta — mas se o documento divergir do código, a pessoa confere o
 * template reprovado contra o corpo errado e conclui que está tudo certo.
 *
 * O documento descreve o CATÁLOGO inteiro (`todasAsDefinicoes`), e não só o que o worker envia
 * hoje: template precisa existir aprovado na Meta ANTES de o código poder usá-lo, então os que
 * esperam a virada também têm de estar na página.
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

const DECLARADOS = todasAsDefinicoes();

interface LinhaDaTabela {
  nome: string;
  variaveis: number;
  botoes: number;
}

/** A tabela-resumo do documento, lida como dado. */
function tabelaDoDoc(): LinhaDaTabela[] {
  const titulo = '## Os sete templates';
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
    linhas.push({ nome, variaveis: Number(celulas[2]), botoes: Number(celulas[3]) });
  }
  return linhas;
}

/**
 * A seção de um template no documento, achada pelo NOME e não pela numeração: o título é
 * `## 3. \`fliqo_remarcacao\``, e um teste que dependa do número quebra quando alguém reordena
 * as seções — o que não é erro nenhum.
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

  it('a tabela lista exatamente os templates que o catálogo tem', () => {
    expect(tabela.map((l) => l.nome).sort()).toEqual(DECLARADOS.map((t) => t.nome).sort());
  });

  /**
   * A contagem de variáveis é o que mais importa depois do nome, e pelo mesmo motivo:
   * template aprovado com um `{{1}}` que o código não manda faz a Meta recusar o envio
   * inteiro (erro 132000), com o mesmo sintoma e na mesma hora ruim.
   */
  it.each(DECLARADOS)('o doc diz a contagem certa de variáveis de $nome', (def) => {
    const linha = tabela.find((l) => l.nome === def.nome);
    expect(linha?.variaveis, `${def.nome} tem contagem errada no doc`).toBe(def.parametros.length);
  });

  it.each(DECLARADOS)('o doc diz a contagem certa de botões de $nome', (def) => {
    expect(tabela.find((l) => l.nome === def.nome)?.botoes).toBe(def.botoes.length);
  });
});

describe('cada template tem a seção com o corpo para submeter', () => {
  it.each(DECLARADOS)('$nome tem seção própria', (def) => {
    expect(secaoDoTemplate(def.nome), `${def.nome} não tem seção no documento`).toBeDefined();
  });

  /**
   * O corpo escrito no doc é EXATAMENTE o que o script submete — não "parecido": o texto, com
   * `{{1}}` no lugar do nome e com as mesmas quebras de linha. É a conferência que pega
   * reescrita de qualquer um dos dois lados; a tabela pode dizer 2 e o corpo trazer 3.
   */
  it.each(DECLARADOS)('o corpo de $nome no doc é o corpo que vai para a Meta', (def) => {
    expect(secaoDoTemplate(def.nome) ?? '', def.nome).toContain(corpoParaMeta(def));
  });

  /** Todo payload que o código manda tem de aparecer na seção, e na ORDEM: ele vai por índice. */
  it.each(DECLARADOS.filter((t) => t.botoes.length > 0))(
    'os botões de $nome estão na seção, em ordem',
    (def) => {
      const secao = secaoDoTemplate(def.nome) ?? '';
      const posicoes = def.botoes.map((b) => secao.indexOf(b.payload));
      for (const [i, pos] of posicoes.entries()) {
        const payload = def.botoes[i]?.payload ?? '';
        expect(pos, `o payload ${payload} não aparece na seção`).toBeGreaterThan(0);
      }
      expect(
        [...posicoes].sort((a, b) => a - b),
        `os botões de ${def.nome} estão em ordem diferente da do código`,
      ).toEqual(posicoes);
    },
  );

  it.each(DECLARADOS.filter((t) => t.botoes.length > 0))(
    'o texto dos botões de $nome está no doc',
    (def) => {
      for (const botao of def.botoes) expect(DOC, botao.texto).toContain(botao.texto);
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

  it('explica por que existe template registrado que ninguém envia ainda', () => {
    // Sem isso, a tabela parece lista de código morto e alguém "limpa" os quatro novos.
    expect(FRASES).toMatch(/aprovação da Meta leva de minutos a dias/);
  });

  it('diz que as variáveis do script não vão para serviço nenhum do Railway nem para o CI', () => {
    expect(FRASES).toMatch(
      /Nenhuma dessas duas variáveis vai para serviço do Railway nem para o CI/,
    );
  });

  it('todo código de erro tratado no código está na tabela de condutas', () => {
    for (const codigo of CODIGOS_TRATADOS) expect(DOC).toContain(String(codigo));
  });

  /**
   * As regras de conteúdo da Meta, conferidas no texto que escrevemos. São as que fazem
   * reprovar, e reprovação custa uma rodada de revisão inteira.
   */
  it('nenhum corpo tem expressão que reprova', () => {
    const proibidas = [/clique aqui/i, /imperd[ií]vel/i, /aproveite/i];
    for (const padrao of proibidas) {
      for (const bloco of DOC.matchAll(/```\n([\s\S]*?)```/g)) {
        expect(
          bloco[1] ?? '',
          `o texto usa "${padrao.source}", que reprova em utility`,
        ).not.toMatch(padrao);
      }
    }
  });

  it('nenhum corpo diz "no-show": a palavra é falta', () => {
    expect(DOC.toLowerCase()).not.toContain('no-show');
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
    for (const def of DECLARADOS) {
      for (const botao of def.botoes) {
        expect(
          botao.texto.length,
          `o botão "${botao.texto}" passa de 25 caracteres`,
        ).toBeLessThanOrEqual(25);
      }
    }
  });
});
