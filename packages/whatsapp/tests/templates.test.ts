import { PAYLOAD_BOTOES } from '@fliqo/core';
import { describe, expect, it } from 'vitest';
import {
  componentesParaRegistro,
  conferirCorpo,
  corpoDoRegistro,
  corpoParaMeta,
  definicaoPorNome,
  parametrosDoCorpo,
  TEMPLATES_META,
  TERMOS_PROIBIDOS,
  todasAsDefinicoes,
  valoresDoCorpo,
  type DefinicaoDeTemplate,
} from '../src/templates';

/**
 * Os nomes fixados por valor, e não lidos do próprio objeto.
 *
 * Teste que lê o nome de `TEMPLATES_META` para conferir `TEMPLATES_META` concorda com
 * qualquer renomeação — inclusive com um `_` virando `-` numa refatoração, que na Meta é
 * outro template e o sintoma só aparece com a clínica real esperando a confirmação.
 */
const NOMES_NA_META = [
  'confirmacao_consulta',
  'lembrete_final',
  'oferta_de_vaga',
  'aviso_de_atraso',
  'atraso_normalizou',
] as const;

describe('o catálogo', () => {
  it('tem os cinco templates, com os nomes exatos que a Meta conhece', () => {
    expect(todasAsDefinicoes().map((d) => d.nome)).toEqual([...NOMES_NA_META]);
  });

  it('nenhum é marketing, e todos são pt_BR', () => {
    for (const def of todasAsDefinicoes()) {
      expect(def.categoria, def.nome).toBe('UTILITY');
      expect(def.idioma, def.nome).toBe('pt_BR');
    }
  });

  it('toda definição passa pelas regras da Meta e pelas nossas', () => {
    for (const def of todasAsDefinicoes()) {
      expect(conferirCorpo(def), def.nome).toEqual([]);
    }
  });

  it('a ordem declarada é a ordem do corpo, em todos', () => {
    // É esta igualdade que torna `parametros` seguro de usar para tipar a chamada: se o
    // corpo for editado e a lista não, o parâmetro nomeado vira posição errada na Meta.
    for (const def of todasAsDefinicoes()) {
      expect(parametrosDoCorpo(def.corpo), def.nome).toEqual([...def.parametros]);
    }
  });

  it('nenhum corpo começa ou termina com variável', () => {
    // A Meta recusa a submissão. Sem este teste, descobre-se no painel da Meta, não aqui.
    for (const def of todasAsDefinicoes()) {
      expect(def.corpo.trim().startsWith('{{'), def.nome).toBe(false);
      expect(def.corpo.trim().endsWith('}}'), def.nome).toBe(false);
    }
  });

  it('nenhum corpo tem emoji', () => {
    for (const def of todasAsDefinicoes()) {
      expect(/\p{Extended_Pictographic}/u.test(def.corpo), def.nome).toBe(false);
    }
  });

  it('nenhum corpo diz "no-show": a palavra é falta', () => {
    for (const def of todasAsDefinicoes()) {
      expect(def.corpo.toLowerCase()).not.toContain('no-show');
      expect(def.corpo.toLowerCase()).not.toContain('no show');
    }
  });

  it('a lista de termos proibidos cobre o vocabulário de propaganda', () => {
    // Fixado por valor: tirar um termo da lista é afrouxar a guarda sem teste nenhum cair.
    for (const termo of ['promoção', 'imperdível', 'clique aqui', 'não perca', 'desconto']) {
      expect(TERMOS_PROIBIDOS).toContain(termo);
    }
  });

  it('acha a definição pelo nome da Meta, e não acha nome que não existe', () => {
    expect(definicaoPorNome('oferta_de_vaga')?.parametros).toEqual([
      'nome_paciente',
      'data',
      'hora',
      'nome_clinica',
    ]);
    expect(definicaoPorNome('oferta_de_vaga_v2')).toBeUndefined();
  });
});

describe('os parâmetros de cada template', () => {
  it('confirmação pede paciente, profissional, DATA, HORA e clínica, nesta ordem', () => {
    // Data e hora separadas: a Meta recusa duas variáveis coladas, e o "às" entre elas é
    // texto aprovado em vez de concatenação nossa.
    expect(TEMPLATES_META.confirmacao.parametros).toEqual([
      'nome_paciente',
      'nome_profissional',
      'data',
      'hora',
      'nome_clinica',
    ]);
  });

  it('oferta de vaga diz QUAL vaga, com data e hora em variáveis separadas', () => {
    // A versão muda deste template era bloqueio de piloto: o paciente recebia "abriu um
    // horário" e um botão que marca a consulta, sem saber que horário era.
    expect(TEMPLATES_META.ofertaDeVaga.parametros).toEqual([
      'nome_paciente',
      'data',
      'hora',
      'nome_clinica',
    ]);
  });

  it('nenhum template tem parâmetro que junte data e hora', () => {
    // Fixado para `data_hora` não voltar por conveniência de um call site.
    for (const def of todasAsDefinicoes()) {
      expect(def.parametros, def.nome).not.toContain('data_hora');
    }
  });

  it('os avisos de atraso levam hora, e não data: o aviso é sempre do dia', () => {
    expect(TEMPLATES_META.avisoDeAtraso.parametros).toEqual(['minutos_de_atraso', 'novo_horario']);
    expect(TEMPLATES_META.atrasoNormalizou.parametros).toEqual(['horario_original']);
  });

  it('o lembrete final não tem variável nenhuma', () => {
    expect(TEMPLATES_META.lembreteFinal.parametros).toEqual([]);
  });
});

describe('os botões', () => {
  it('confirmação tem TRÊS, nesta ordem, com os payloads do core', () => {
    // O terceiro é o único toque que libera o horário e chama a lista de espera. Fixado em
    // três de propósito: cair para dois é perder esse caminho sem nada quebrar.
    expect(TEMPLATES_META.confirmacao.botoes).toEqual([
      { texto: 'Confirmar presença', payload: PAYLOAD_BOTOES.CONFIRMAR },
      { texto: 'Preciso remarcar', payload: PAYLOAD_BOTOES.REMARCAR },
      { texto: 'Não vou poder ir', payload: PAYLOAD_BOTOES.CANCELAR },
    ]);
  });

  it('oferta de vaga tem um só, e é o payload que a lista de espera entende', () => {
    expect(TEMPLATES_META.ofertaDeVaga.botoes).toEqual([
      { texto: 'Quero este horário', payload: PAYLOAD_BOTOES.QUERO_VAGA },
    ]);
  });

  it('lembrete final e atraso normalizou não têm botão', () => {
    expect(TEMPLATES_META.lembreteFinal.botoes).toEqual([]);
    expect(TEMPLATES_META.atrasoNormalizou.botoes).toEqual([]);
  });

  it('todo payload de botão é um dos que o core sabe interpretar', () => {
    // Payload que o core não conhece volta do webhook como texto livre e cai na IA, que não
    // tem como marcar nem confirmar nada. Falha silenciosa, a pior espécie.
    const conhecidos: readonly string[] = Object.values(PAYLOAD_BOTOES);
    for (const def of todasAsDefinicoes()) {
      for (const botao of def.botoes) {
        expect(conhecidos, `${def.nome}: ${botao.texto}`).toContain(botao.payload);
      }
    }
  });
});

describe('o corpo nomeado vira o corpo posicional da Meta', () => {
  it('{{nome_paciente}} vira {{1}} na ordem de aparição, e data/hora viram {{2}} e {{3}}', () => {
    expect(corpoParaMeta(TEMPLATES_META.ofertaDeVaga)).toBe(
      'Olá, {{1}}. Abriu um horário na nossa agenda: {{2}}, às {{3}}.\n' +
        '\n' +
        'Você está na lista de espera para este atendimento. Quem responder primeiro fica com o horário; se não der para você, não precisa fazer nada.\n' +
        '\n' +
        'Mensagem da clínica {{4}}. Pode responder nesta conversa.',
    );
  });

  it('nunca sai {{n}}{{n+1}} colado: a Meta recusa', () => {
    for (const def of todasAsDefinicoes()) {
      expect(corpoParaMeta(def), def.nome).not.toMatch(/\}\}\s*\{\{/);
    }
  });

  it('template sem parâmetro sai igual ao que entrou', () => {
    const def = TEMPLATES_META.lembreteFinal;
    expect(corpoParaMeta(def)).toBe(def.corpo);
  });

  it('o corpo da Meta numera de 1 a N, sem buraco e sem repetição', () => {
    for (const def of todasAsDefinicoes()) {
      const numeros = [...corpoParaMeta(def).matchAll(/\{\{(\d+)\}\}/g)].map((a) => Number(a[1]));
      expect(numeros, def.nome).toEqual(def.parametros.map((_, i) => i + 1));
    }
  });

  it('nenhum corpo da Meta sobra com nome entre chaves', () => {
    // Um `{{nome_paciente}}` que escapasse seria texto literal na mensagem do paciente.
    for (const def of todasAsDefinicoes()) {
      expect(corpoParaMeta(def), def.nome).not.toMatch(/\{\{[a-z_]/);
    }
  });
});

describe('o corpo do POST de registro', () => {
  it('leva nome, idioma, categoria e os componentes', () => {
    const corpo = corpoDoRegistro(TEMPLATES_META.ofertaDeVaga);
    expect(corpo['name']).toBe('oferta_de_vaga');
    expect(corpo['language']).toBe('pt_BR');
    expect(corpo['category']).toBe('UTILITY');
  });

  it('o BODY leva um exemplo por variável, na mesma ordem', () => {
    const [corpo] = componentesParaRegistro(TEMPLATES_META.confirmacao) as [
      { type: string; text: string; example: { body_text: string[][] } },
    ];
    expect(corpo.type).toBe('BODY');
    expect(corpo.example.body_text[0]).toEqual([
      'Maria',
      'Dra. Helena',
      'terça, 14/10',
      '14:30',
      'Clínica Modelo',
    ]);
  });

  it('template sem variável não leva example: a Meta recusa example vazio', () => {
    const [corpo] = componentesParaRegistro(TEMPLATES_META.lembreteFinal) as [
      Record<string, unknown>,
    ];
    expect(corpo['example']).toBeUndefined();
  });

  it('os botões vão como QUICK_REPLY, com o texto e sem o payload', () => {
    // O payload é por envio, não por template: mandá-lo no registro é pedir recusa.
    const componentes = componentesParaRegistro(TEMPLATES_META.confirmacao);
    expect(componentes[1]).toEqual({
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirmar presença' },
        { type: 'QUICK_REPLY', text: 'Preciso remarcar' },
        { type: 'QUICK_REPLY', text: 'Não vou poder ir' },
      ],
    });
    expect(JSON.stringify(componentes)).not.toContain('CONFIRMAR_CONSULTA');
  });

  it('template sem botão não leva o componente BUTTONS', () => {
    expect(componentesParaRegistro(TEMPLATES_META.lembreteFinal)).toHaveLength(1);
  });
});

describe('conferirCorpo pega cada defeito', () => {
  const base: DefinicaoDeTemplate = {
    nome: 'teste',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['a'],
    corpo: 'Olá, {{a}}. Fim.',
    exemplos: { a: 'Maria' },
    botoes: [],
  };

  it('aceita o que está certo', () => {
    expect(conferirCorpo(base)).toEqual([]);
  });

  it('recusa variável abrindo o corpo', () => {
    expect(conferirCorpo({ ...base, corpo: '{{a}} é o nome.' })).toContain(
      'parametro_abre_o_corpo',
    );
  });

  it('recusa variável fechando o corpo', () => {
    expect(conferirCorpo({ ...base, corpo: 'O nome é {{a}}' })).toContain(
      'parametro_fecha_o_corpo',
    );
  });

  it('recusa duas variáveis coladas, com ou sem espaço entre elas', () => {
    // A Meta recusa na submissão, e é a regra que separou `data_hora` em `{{data}}` e
    // `{{hora}}`. Espaço não conta como texto: tem de haver palavra entre as duas.
    const base2 = { ...base, parametros: ['a', 'b'], exemplos: { a: 'x', b: 'y' } };
    expect(conferirCorpo({ ...base2, corpo: 'Olá, {{a}}{{b}}. Fim.' })).toContain(
      'parametros_colados',
    );
    expect(conferirCorpo({ ...base2, corpo: 'Olá, {{a}} {{b}}. Fim.' })).toContain(
      'parametros_colados',
    );
    // Com texto entre elas, passa — é a forma que os nossos corpos usam.
    expect(conferirCorpo({ ...base2, corpo: 'Olá, {{a}}, às {{b}}. Fim.' })).toEqual([]);
  });

  it('recusa a mesma variável duas vezes', () => {
    expect(conferirCorpo({ ...base, corpo: 'Olá {{a}}, tudo bem {{a}}? Fim.' })).toContain(
      'parametro_repetido',
    );
  });

  it('recusa parâmetro declarado que não está no corpo', () => {
    expect(
      conferirCorpo({ ...base, parametros: ['a', 'b'], exemplos: { a: 'x', b: 'y' } }),
    ).toEqual(expect.arrayContaining(['parametro_declarado_fora_do_corpo', 'exemplo_sobrando']));
  });

  it('recusa variável no corpo que ninguém declarou', () => {
    expect(conferirCorpo({ ...base, corpo: 'Olá, {{a}} e {{b}}. Fim.' })).toContain(
      'parametro_do_corpo_nao_declarado',
    );
  });

  it('recusa ordem declarada diferente da ordem do corpo', () => {
    const trocado: DefinicaoDeTemplate = {
      ...base,
      parametros: ['b', 'a'],
      corpo: 'Olá, {{a}}, aqui é {{b}}. Fim.',
      exemplos: { a: 'Maria', b: 'Clínica' },
    };
    expect(conferirCorpo(trocado)).toEqual(['ordem_divergente']);
  });

  it('recusa exemplo faltando: sem ele a Meta não aprova', () => {
    expect(conferirCorpo({ ...base, exemplos: {} })).toContain('exemplo_ausente');
  });

  it('recusa exemplo em branco', () => {
    expect(conferirCorpo({ ...base, exemplos: { a: '   ' } })).toContain('exemplo_ausente');
  });

  it('recusa linguagem de propaganda', () => {
    expect(conferirCorpo({ ...base, corpo: 'Olá, {{a}}. Promoção imperdível! Fim.' })).toContain(
      'termo_proibido',
    );
  });
});

describe('os valores do corpo', () => {
  it('saem na ordem posicional, a partir do objeto nomeado', () => {
    expect(
      valoresDoCorpo(TEMPLATES_META.ofertaDeVaga, {
        nome_clinica: 'Clínica Modelo',
        hora: '09:00',
        nome_paciente: 'Maria',
        data: 'quinta, 16/10',
      }),
    ).toEqual({ ok: true, valores: ['Maria', 'quinta, 16/10', '09:00', 'Clínica Modelo'] });
  });

  it('recusa parâmetro ausente, dizendo qual', () => {
    expect(
      valoresDoCorpo(TEMPLATES_META.ofertaDeVaga, { nome_paciente: 'Maria', data: 'terça' }),
    ).toEqual({ ok: false, motivo: 'parametro_ausente', parametro: 'hora' });
  });

  it('recusa parâmetro em branco em vez de mandar frase com buraco', () => {
    // A Meta aceita string vazia sem reclamar: "Sua consulta com  está marcada para ".
    expect(valoresDoCorpo(TEMPLATES_META.atrasoNormalizou, { horario_original: '  ' })).toEqual({
      ok: false,
      motivo: 'parametro_vazio',
      parametro: 'horario_original',
    });
  });

  it('template sem parâmetro não exige nada', () => {
    expect(valoresDoCorpo(TEMPLATES_META.lembreteFinal, {})).toEqual({ ok: true, valores: [] });
  });
});
