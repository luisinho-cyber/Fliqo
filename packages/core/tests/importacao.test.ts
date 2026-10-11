import { describe, expect, it } from 'vitest';
import {
  adivinharMapa,
  CAMPOS_OBRIGATORIOS,
  descobrirSeparador,
  lerDataHora,
  lerLinha,
  MAXIMO_DE_LINHAS,
  MOTIVOS_DE_RECUSA,
  RECURSOS_DO_MODO_PROPRIO,
  recursoLiberado,
  separarCampos,
  type MapaDeColunas,
} from '../src';

/**
 * A leitura da planilha do outro sistema.
 *
 * O que é testado aqui é tudo que não precisa de banco: separar campos, adivinhar o
 * cabeçalho, ler data e hora brasileira, e recusar linha com motivo. O caso que mais
 * importa é o telefone — mas ele é testado contra o Postgres, porque a deduplicação
 * acontece no repositório.
 */

describe('separar campos', () => {
  it('ponto e vírgula, que é o que o Excel em português exporta', () => {
    expect(separarCampos('a;b;c\n1;2;3\n', ';')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('vírgula dentro de campo entre aspas não separa', () => {
    expect(separarCampos('nome,fone\n"Silva, Maria",11999\n', ',')).toEqual([
      ['nome', 'fone'],
      ['Silva, Maria', '11999'],
    ]);
  });

  it('aspas duplicada dentro do campo é uma aspas literal', () => {
    expect(separarCampos('a\n"disse ""oi"""\n', ',')).toEqual([['a'], ['disse "oi"']]);
  });

  it('fim de linha dentro de campo com aspas não termina a linha', () => {
    expect(separarCampos('obs\n"linha um\nlinha dois"\n', ',')).toEqual([
      ['obs'],
      ['linha um\nlinha dois'],
    ]);
  });

  it('CRLF do Windows não deixa \\r no fim do campo', () => {
    expect(separarCampos('a;b\r\n1;2\r\n', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('o BOM do Excel não cola na primeira coluna', () => {
    // Sem isto, o cabeçalho vem com um caractere invisível e nunca casa com pista
    // nenhuma — e o erro é invisível na tela, que é o pior tipo.
    const [cabecalho] = separarCampos('﻿paciente;fone\n', ';');
    expect(cabecalho?.[0]).toBe('paciente');
  });

  it('linha vazia no fim do arquivo não vira linha', () => {
    expect(separarCampos('a;b\n1;2\n\n\n', ';')).toHaveLength(2);
  });

  it('campo vazio continua sendo campo', () => {
    expect(separarCampos('a;;c\n', ';')).toEqual([['a', '', 'c']]);
  });
});

describe('descobrir o separador', () => {
  it('escolhe pelo cabeçalho, pelo que dá mais colunas', () => {
    expect(descobrirSeparador('paciente;telefone;inicio\n')).toBe(';');
    expect(descobrirSeparador('paciente,telefone,inicio\n')).toBe(',');
    expect(descobrirSeparador('paciente\ttelefone\tinicio\n')).toBe('\t');
  });

  /**
   * O caso que obriga a decidir pelo cabeçalho: o arquivo tem mais vírgulas do que
   * ponto e vírgula, porque os nomes têm vírgula dentro. Contar o arquivo inteiro
   * escolheria a vírgula e partiria todos os nomes em dois.
   */
  it('vírgula dentro de nome não rouba a decisão', () => {
    const arquivo = 'paciente;telefone\n"Silva, Maria";11999\n"Souza, Ana";11888\n';
    expect(descobrirSeparador(arquivo)).toBe(';');
  });
});

describe('adivinhar o mapeamento', () => {
  it('reconhece cabeçalhos comuns, com e sem acento', () => {
    expect(
      adivinharMapa(['Paciente', 'Celular', 'Profissional', 'Início', 'Procedimento']),
    ).toEqual({ paciente: 0, telefone: 1, profissional: 2, inicio: 3, procedimento: 4 });
  });

  it('entende outro vocabulário do mesmo conceito', () => {
    expect(adivinharMapa(['Nome', 'WhatsApp', 'Dentista', 'Data', 'Tratamento'])).toEqual({
      paciente: 0,
      telefone: 1,
      profissional: 2,
      inicio: 3,
      procedimento: 4,
    });
  });

  it('não usa a mesma coluna para dois campos', () => {
    // "Data" e "Hora" casam as duas com as pistas de início; só uma pode ficar.
    const mapa = adivinharMapa(['Data', 'Hora', 'Nome']);
    const indices = Object.values(mapa);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('cabeçalho que não reconhece devolve mapa incompleto, e não um palpite errado', () => {
    // Melhor a tela pedir à clínica do que importar a coluna errada em silêncio.
    const mapa = adivinharMapa(['col1', 'col2', 'col3']);
    expect(Object.keys(mapa)).toEqual([]);
  });
});

describe('ler data e hora', () => {
  it('o formato brasileiro, que é o que todo sistema daqui exporta', () => {
    expect(lerDataHora('05/10/2026 14:00')).toBe('2026-10-05 14:00');
    expect(lerDataHora('5/10/2026 9:30')).toBe('2026-10-05 09:30');
  });

  it('ISO também', () => {
    expect(lerDataHora('2026-10-05 14:00')).toBe('2026-10-05 14:00');
    expect(lerDataHora('2026-10-05T14:00:00')).toBe('2026-10-05 14:00');
  });

  it('ano de dois dígitos é deste século', () => {
    expect(lerDataHora('05/10/26 14:00')).toBe('2026-10-05 14:00');
  });

  /**
   * Sem hora, recusa. Assumir meia-noite poria uma consulta falsa na agenda sem
   * ninguém notar — e a planilha sem hora é erro de exportação, não de intenção.
   */
  it('data sem hora é recusada, não vira meia-noite', () => {
    expect(lerDataHora('05/10/2026')).toBeUndefined();
  });

  it('dia que não existe no mês é recusado', () => {
    expect(lerDataHora('31/02/2026 10:00')).toBeUndefined();
    expect(lerDataHora('32/01/2026 10:00')).toBeUndefined();
  });

  it('hora impossível é recusada', () => {
    expect(lerDataHora('05/10/2026 25:00')).toBeUndefined();
    expect(lerDataHora('05/10/2026 10:75')).toBeUndefined();
  });

  it('texto que não é data é recusado', () => {
    expect(lerDataHora('amanhã de manhã')).toBeUndefined();
    expect(lerDataHora('')).toBeUndefined();
  });

  /** A saída NÃO tem fuso de propósito: quem converte é o Postgres, com o fuso da clínica. */
  it('a saída é hora local, sem fuso e sem Z', () => {
    const lido = lerDataHora('05/10/2026 14:00');
    expect(lido).not.toContain('Z');
    expect(lido).not.toContain('+');
    expect(lido).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('ler uma linha', () => {
  const mapa: MapaDeColunas = {
    paciente: 0,
    telefone: 1,
    profissional: 2,
    inicio: 3,
    procedimento: 4,
  };
  const boa = ['Maria Silva', '11999887766', 'Dra. Ana', '05/10/2026 14:00', 'Limpeza'];

  it('linha completa passa', () => {
    expect(lerLinha(boa, mapa)).toEqual({
      ok: true,
      linha: {
        paciente: 'Maria Silva',
        telefone: '11999887766',
        profissional: 'Dra. Ana',
        procedimento: 'Limpeza',
        inicioLocal: '2026-10-05 14:00',
      },
    });
  });

  it.each([
    ['sem_paciente', 0],
    ['telefone_invalido', 1],
    ['sem_profissional', 2],
    ['data_invalida', 3],
    ['sem_procedimento', 4],
  ])('campo vazio recusa com motivo %s', (motivo, indice) => {
    const linha = [...boa];
    linha[indice] = '';
    expect(lerLinha(linha, mapa)).toMatchObject({ ok: false, motivo });
  });

  it('linha mais curta que o mapeamento é recusada com motivo próprio', () => {
    expect(lerLinha(['Maria', '11999'], mapa)).toMatchObject({
      ok: false,
      motivo: 'colunas_de_menos',
    });
  });

  it('a recusa leva o nome como rótulo, para a pessoa reconhecer a linha', () => {
    const linha = [...boa];
    linha[3] = 'amanhã';
    expect(lerLinha(linha, mapa)).toMatchObject({ rotulo: 'Maria Silva' });
  });

  it('espaço em volta dos campos não conta como conteúdo', () => {
    const linha = ['  Maria  ', ' 11999887766 ', ' Dra. Ana ', ' 05/10/2026 14:00 ', ' Limpeza '];
    expect(lerLinha(linha, mapa)).toMatchObject({
      ok: true,
      linha: { paciente: 'Maria', procedimento: 'Limpeza' },
    });
  });

  it('o rótulo é cortado no tamanho que a coluna aceita', () => {
    const linha = [...boa];
    linha[0] = 'x'.repeat(300);
    linha[3] = 'amanhã';
    const r = lerLinha(linha, mapa);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rotulo.length).toBeLessThanOrEqual(120);
  });
});

describe('o que o modo convidado desliga', () => {
  /**
   * A guarda que o pedido exige: prontuário e financeiro na lista.
   *
   * Hoje nenhuma das duas telas existe. A lista existe antes delas de propósito, com
   * a guarda `comRecurso` na API — para que a tela nasça coberta em vez de nascer
   * aberta e alguém lembrar depois.
   */
  it('prontuário e financeiro estão na lista', () => {
    expect([...RECURSOS_DO_MODO_PROPRIO].sort()).toEqual(['financeiro', 'prontuario']);
  });

  it('em modo convidado, os dois estão desligados', () => {
    for (const recurso of RECURSOS_DO_MODO_PROPRIO) {
      expect(recursoLiberado(recurso, { modoConvidado: true })).toBe(false);
      expect(recursoLiberado(recurso, { modoConvidado: false })).toBe(true);
    }
  });

  /**
   * O resto do sistema NÃO muda. É a afirmação central do modo convidado, e sem este
   * teste ela é só uma frase no commit: confirmação, lista de espera, atraso e
   * atendente funcionam sobre consulta importada como sobre consulta criada aqui.
   */
  it('a lista não cresceu para fora de prontuário e financeiro', () => {
    expect(RECURSOS_DO_MODO_PROPRIO).toHaveLength(2);
  });
});

describe('as listas e os limites são escritos', () => {
  it('o mapeamento exige cinco campos', () => {
    expect([...CAMPOS_OBRIGATORIOS].sort()).toEqual([
      'inicio',
      'paciente',
      'procedimento',
      'profissional',
      'telefone',
    ]);
  });

  it('todo motivo de recusa está declarado uma vez', () => {
    expect(new Set(MOTIVOS_DE_RECUSA).size).toBe(MOTIVOS_DE_RECUSA.length);
  });

  it('o teto de linhas é um número escrito', () => {
    expect(MAXIMO_DE_LINHAS).toBe(2000);
  });
});
