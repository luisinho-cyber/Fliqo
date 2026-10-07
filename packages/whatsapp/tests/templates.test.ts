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
  'fliqo_confirmacao_consulta',
  'fliqo_lembrete_vespera',
  'fliqo_remarcacao',
  'fliqo_vaga_liberada',
  // Os dois que a régua ainda envia, até a virada.
  'confirmacao_consulta',
  'oferta_de_vaga',
  'lembrete_final',
  'aviso_de_atraso',
  'atraso_normalizou',
] as const;

describe('o catálogo', () => {
  it('tem os nove templates, com os nomes exatos que a Meta conhece', () => {
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
    expect(definicaoPorNome('fliqo_vaga_liberada')?.parametros).toEqual([
      'nome_paciente',
      'data_hora',
      'nome_clinica',
    ]);
    expect(definicaoPorNome('fliqo_vaga_liberada_v2')).toBeUndefined();
  });
});

describe('os parâmetros de cada template', () => {
  it('confirmação pede paciente, profissional, data e clínica, nesta ordem', () => {
    expect(TEMPLATES_META.confirmacaoConsulta.parametros).toEqual([
      'nome_paciente',
      'nome_profissional',
      'data_hora',
      'nome_clinica',
    ]);
  });

  it('lembrete da véspera pede os mesmos quatro', () => {
    expect(TEMPLATES_META.lembreteVespera.parametros).toEqual([
      'nome_paciente',
      'nome_profissional',
      'data_hora',
      'nome_clinica',
    ]);
  });

  it('remarcação pede dois', () => {
    expect(TEMPLATES_META.remarcacao.parametros).toEqual(['nome_paciente', 'nome_clinica']);
  });

  it('vaga liberada diz QUAL vaga: data_hora é parâmetro', () => {
    // A versão muda deste template era bloqueio de piloto: o paciente recebia "abriu um
    // horário" e um botão que marca a consulta, sem saber que horário era.
    expect(TEMPLATES_META.vagaLiberada.parametros).toContain('data_hora');
  });
});

describe('os botões', () => {
  it('confirmação tem dois, nesta ordem, com os payloads do core', () => {
    expect(TEMPLATES_META.confirmacaoConsulta.botoes).toEqual([
      { texto: 'Confirmar', payload: PAYLOAD_BOTOES.CONFIRMAR },
      { texto: 'Preciso remarcar', payload: PAYLOAD_BOTOES.REMARCAR },
    ]);
  });

  it('vaga liberada tem um só, e é o payload que a lista de espera entende', () => {
    expect(TEMPLATES_META.vagaLiberada.botoes).toEqual([
      { texto: 'Quero essa vaga', payload: PAYLOAD_BOTOES.QUERO_VAGA },
    ]);
  });

  it('remarcação e lembrete final não têm botão', () => {
    expect(TEMPLATES_META.remarcacao.botoes).toEqual([]);
    expect(TEMPLATES_META.lembreteFinal.botoes).toEqual([]);
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
  it('{{nome_paciente}} vira {{1}} na ordem de aparição', () => {
    expect(corpoParaMeta(TEMPLATES_META.vagaLiberada)).toBe(
      'Olá, {{1}}. Abriu um horário na nossa agenda: {{2}}.\n' +
        '\n' +
        'Você está na lista de espera para este atendimento. Quem responder primeiro fica com o horário; se não der para você, não precisa fazer nada.\n' +
        '\n' +
        'Mensagem da clínica {{3}}. Pode responder nesta conversa.',
    );
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
    const corpo = corpoDoRegistro(TEMPLATES_META.remarcacao);
    expect(corpo['name']).toBe('fliqo_remarcacao');
    expect(corpo['language']).toBe('pt_BR');
    expect(corpo['category']).toBe('UTILITY');
  });

  it('o BODY leva um exemplo por variável, na mesma ordem', () => {
    const [corpo] = componentesParaRegistro(TEMPLATES_META.confirmacaoConsulta) as [
      { type: string; text: string; example: { body_text: string[][] } },
    ];
    expect(corpo.type).toBe('BODY');
    expect(corpo.example.body_text[0]).toEqual([
      'Maria',
      'Dra. Helena',
      'terça, 14/10, às 14:30',
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
    const componentes = componentesParaRegistro(TEMPLATES_META.confirmacaoConsulta);
    expect(componentes[1]).toEqual({
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirmar' },
        { type: 'QUICK_REPLY', text: 'Preciso remarcar' },
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
      valoresDoCorpo(TEMPLATES_META.vagaLiberada, {
        nome_clinica: 'Clínica Modelo',
        nome_paciente: 'Maria',
        data_hora: 'quinta, 16/10, às 09:00',
      }),
    ).toEqual({ ok: true, valores: ['Maria', 'quinta, 16/10, às 09:00', 'Clínica Modelo'] });
  });

  it('recusa parâmetro ausente, dizendo qual', () => {
    expect(valoresDoCorpo(TEMPLATES_META.remarcacao, { nome_paciente: 'Maria' })).toEqual({
      ok: false,
      motivo: 'parametro_ausente',
      parametro: 'nome_clinica',
    });
  });

  it('recusa parâmetro em branco em vez de mandar frase com buraco', () => {
    // A Meta aceita string vazia sem reclamar: "Sua consulta com  está marcada para ".
    expect(
      valoresDoCorpo(TEMPLATES_META.remarcacao, { nome_paciente: 'Maria', nome_clinica: '  ' }),
    ).toEqual({ ok: false, motivo: 'parametro_vazio', parametro: 'nome_clinica' });
  });

  it('template sem parâmetro não exige nada', () => {
    expect(valoresDoCorpo(TEMPLATES_META.lembreteFinal, {})).toEqual({ ok: true, valores: [] });
  });
});
