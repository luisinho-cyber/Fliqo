import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  chamadasDaResposta,
  checarEntrada,
  checarSaida,
  definicoesParaApi,
  montarPromptSistema,
  PerfilClinicaSchema,
  somarUso,
  textoDaResposta,
  validarChamada,
} from '../src';

const perfilDemo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../db/seeds/perfil-clinica-demo.json', import.meta.url)),
    'utf8',
  ),
);

describe('perfil da clínica', () => {
  it('o perfil de demonstração é válido', () => {
    expect(PerfilClinicaSchema.safeParse(perfilDemo).success).toBe(true);
  });
  it('perfil incompleto é recusado antes de ir para produção', () => {
    expect(PerfilClinicaSchema.safeParse({ ...perfilDemo, persona: { nome: 'J' } }).success).toBe(
      false,
    );
  });
});

describe('prompt', () => {
  const perfil = PerfilClinicaSchema.parse(perfilDemo);
  const prompt = montarPromptSistema(
    perfil,
    [
      {
        id: '11111111-1111-4111-8111-111111111111',
        nome: 'Botox',
        duracaoMin: 40,
        precoCentavos: 150_000,
        exibirPreco: true,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        nome: 'Lentes de contato dental',
        duracaoMin: 90,
        precoCentavos: 0,
        exibirPreco: false,
      },
    ],
    new Date('2026-11-10T13:00:00Z'),
  );
  it('traz a tabela de preços do banco e respeita "preço na avaliação"', () => {
    expect(prompt).toContain('Botox');
    expect(prompt).toMatch(/R\$ 1\.500,00/);
    expect(prompt).toContain(
      'Lentes de contato dental (id 22222222-2222-4222-8222-222222222222, 90 min, preço informado na avaliação)',
    );
  });
  it('usa persona, tratamento e regras da clínica', () => {
    expect(prompt).toContain('Você é Juliana');
    expect(prompt).toContain('"a senhora"');
    expect(prompt).toContain('Não comente sobre outras clínicas');
  });
});

describe('ferramentas', () => {
  it('gera definições para a API da Anthropic', () => {
    const defs = definicoesParaApi();
    expect(defs.map((d) => d.name)).toContain('marcar_consulta');
    const marcar = defs.find((d) => d.name === 'marcar_consulta')!;
    expect(marcar.input_schema).toMatchObject({
      type: 'object',
      required: ['procedimento_id', 'inicio'],
    });
  });
  it('rejeita entrada inválida e descarta ids que a IA tente injetar', () => {
    expect(validarChamada('marcar_consulta', { procedimento_id: 'x', inicio: 'amanhã' }).ok).toBe(
      false,
    );
    const r = validarChamada('minhas_consultas', { patient_id: 'outra-pessoa' });
    expect(r).toEqual({ ok: true, nome: 'minhas_consultas', entrada: {} });
    expect(validarChamada('apagar_tudo', {}).ok).toBe(false);
  });
});

describe('proteções de entrada', () => {
  it('emergência é urgente e não passa pela IA', () => {
    expect(
      checarEntrada({ texto: 'fiz o procedimento ontem e agora estou com falta de ar' }),
    ).toMatchObject({ transferir: true, urgente: true });
  });
  it('pedido de humano, frustração, áudio longo e gatilho da clínica', () => {
    expect(checarEntrada({ texto: 'quero falar com a recepção' }).transferir).toBe(true);
    expect(checarEntrada({ texto: 'isso é um absurdo' }).transferir).toBe(true);
    expect(checarEntrada({ texto: '[áudio]', audioSegundos: 120 }).transferir).toBe(true);
    expect(checarEntrada({ texto: 'e o reembolso?' }, ['reembolso']).transferir).toBe(true);
  });
  it('mensagem comum segue para a IA', () => {
    expect(checarEntrada({ texto: 'tem horário quinta à tarde?' })).toEqual({ transferir: false });
  });
});

describe('proteções de saída', () => {
  it('tira formatação de robô', () => {
    const r = checarSaida('**Claro!**\n- terça 14h\n- quinta 9h', []);
    expect(r).toEqual({ ok: true, texto: 'Claro!\nterça 14h\nquinta 9h' });
  });
  it('bloqueia preço inventado e aceita preço da tabela', () => {
    expect(checarSaida('Fica R$ 1.200,00.', [150_000]).ok).toBe(false);
    expect(checarSaida('Fica R$ 1.500,00.', [150_000]).ok).toBe(true);
  });
  it('bloqueia promessa e diagnóstico', () => {
    expect(checarSaida('Resultado garantido!', []).ok).toBe(false);
    expect(checarSaida('Você tem uma inflamação, pode tomar ibuprofeno.', []).ok).toBe(false);
  });
});

describe('expediente no perfil', () => {
  it('perfil antigo ganha o expediente comercial padrão, sem quebrar', () => {
    // Os perfis já salvos em app.ai_profiles não têm o campo: o default é o que
    // impede uma clínica existente de ficar sem horário nenhum para oferecer.
    const { expediente, antecedenciaMinimaMin } = PerfilClinicaSchema.parse({
      ...perfilDemo,
      atendimento: { horarioHumano: 'seg a sex, 8h às 19h' },
    }).atendimento;
    expect(expediente).toHaveLength(10); // segunda a sexta, manhã e tarde
    expect(expediente[0]).toEqual({ diaDaSemana: 1, de: '08:00', ate: '12:00' });
    expect(antecedenciaMinimaMin).toBe(120);
  });

  it('recusa hora fora do formato HH:MM', () => {
    const r = PerfilClinicaSchema.safeParse({
      ...perfilDemo,
      atendimento: {
        horarioHumano: 'seg a sex',
        expediente: [{ diaDaSemana: 1, de: '8h', ate: '19h' }],
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('resposta do modelo', () => {
  const resposta = {
    blocos: [
      { tipo: 'texto' as const, texto: 'Deixa comigo.' },
      { tipo: 'chamada' as const, id: 't1', nome: 'buscar_horarios', entrada: {} },
    ],
    parada: 'ferramenta' as const,
    modelo: 'm',
    uso: { entrada: 10, saida: 2, cacheLido: 0, cacheCriado: 0 },
  };

  it('separa o que é texto do que é chamada de ferramenta', () => {
    expect(textoDaResposta(resposta)).toBe('Deixa comigo.');
    expect(chamadasDaResposta(resposta).map((c) => c.nome)).toEqual(['buscar_horarios']);
  });

  it('soma o consumo das voltas do laço', () => {
    expect(somarUso(resposta.uso, resposta.uso)).toEqual({
      entrada: 20,
      saida: 4,
      cacheLido: 0,
      cacheCriado: 0,
    });
  });
});
