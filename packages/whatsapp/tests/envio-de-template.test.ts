import { describe, expect, it } from 'vitest';
import type { EnvioDeTemplate, ResultadoEnvio } from '../src/cliente';
import {
  criarEnviadorDeTemplate,
  type PortasDoEnvio,
  type RegistroDeEnvio,
} from '../src/envio-de-template';
import { classificarFalha, CODIGOS_TRATADOS } from '../src/erros-meta';
import { ClienteMeta } from '../src/meta';
import type { Relogio } from '../src/limite';

/** Relógio que não dorme: os três backoffs do cliente tornariam o teste lento de verdade. */
const RELOGIO_PARADO: Relogio = { agora: () => 0, esperar: () => Promise.resolve() };

function respostaDeErro(status: number, codigo: number, mensagem: string): Response {
  return new Response(JSON.stringify({ error: { message: mensagem, code: codigo } }), { status });
}

function clienteComResposta(resposta: () => Response): {
  cliente: ClienteMeta;
  chamadas: () => number;
} {
  let chamadas = 0;
  const cliente = new ClienteMeta({
    token: 'token-falso-de-teste',
    relogio: RELOGIO_PARADO,
    buscar: () => {
      chamadas++;
      return Promise.resolve(resposta());
    },
  });
  return { cliente, chamadas: () => chamadas };
}

const ENVIO: EnvioDeTemplate = {
  phoneNumberId: '111',
  paraE164: '+5511999990000',
  template: 'fliqo_remarcacao',
  variaveis: ['Maria', 'Clínica Modelo'],
};

describe('os códigos de erro da Meta viram falha tipada', () => {
  it('131026: destinatário indisponível, definitivo', () => {
    const c = classificarFalha(400, 131026);
    expect(c.falha).toBe('destinatario_indisponivel');
    expect(c.motivo).toBe('recusado');
    expect(c.conduta).toContain('cadastro');
  });

  it('131047: fora da janela de 24 h, definitivo', () => {
    const c = classificarFalha(400, 131047);
    expect(c.falha).toBe('fora_da_janela');
    expect(c.motivo).toBe('recusado');
  });

  it('132000: contagem de parâmetros diferente da aprovada, definitivo', () => {
    const c = classificarFalha(400, 132000);
    expect(c.falha).toBe('parametros_do_template');
    expect(c.motivo).toBe('recusado');
  });

  it('132001: template inexistente ou não aprovado, definitivo', () => {
    const c = classificarFalha(400, 132001);
    expect(c.falha).toBe('template_inexistente');
    expect(c.motivo).toBe('recusado');
    expect(c.conduta).toContain('registrar-templates');
  });

  it('os quatro códigos do contrato estão todos tratados', () => {
    // Fixados por valor: tirar um da tabela faz o cliente cair no "desconhecida", e a
    // conduta certa — ligar para o paciente, reaprovar o template — se perde.
    for (const codigo of [131026, 131047, 132000, 132001]) {
      expect(CODIGOS_TRATADOS).toContain(codigo);
    }
  });

  it('o código manda, não o status: 400 com código de limite é temporário', () => {
    expect(classificarFalha(400, 131048).motivo).toBe('temporario');
  });

  it('429 sem código é limite, e 5xx é instabilidade', () => {
    expect(classificarFalha(429).falha).toBe('limite_de_envio');
    expect(classificarFalha(503).falha).toBe('instabilidade_da_meta');
  });

  it('código que não conhecemos não é tratado como temporário', () => {
    // Repetir um definitivo gasta o limite de envio do número da clínica sem consertar nada.
    const c = classificarFalha(400, 999999);
    expect(c.falha).toBe('desconhecida');
    expect(c.motivo).toBe('recusado');
  });
});

describe('o cliente da Meta devolve a falha tipada e não repete o definitivo', () => {
  it('131026 volta como destinatario_indisponivel, numa tentativa só', async () => {
    const { cliente, chamadas } = clienteComResposta(() =>
      respostaDeErro(400, 131026, 'Message undeliverable'),
    );
    const r = await cliente.enviarTemplate(ENVIO);
    expect(r).toMatchObject({ ok: false, motivo: 'recusado', falha: 'destinatario_indisponivel' });
    expect(chamadas()).toBe(1);
  });

  it('131047 volta como fora_da_janela, numa tentativa só', async () => {
    const { cliente, chamadas } = clienteComResposta(() =>
      respostaDeErro(400, 131047, 'Re-engagement message'),
    );
    expect(await cliente.enviarTemplate(ENVIO)).toMatchObject({ falha: 'fora_da_janela' });
    expect(chamadas()).toBe(1);
  });

  it('132000 volta como parametros_do_template, numa tentativa só', async () => {
    const { cliente, chamadas } = clienteComResposta(() =>
      respostaDeErro(400, 132000, 'number of parameters does not match'),
    );
    expect(await cliente.enviarTemplate(ENVIO)).toMatchObject({
      falha: 'parametros_do_template',
    });
    expect(chamadas()).toBe(1);
  });

  it('132001 volta como template_inexistente, numa tentativa só', async () => {
    const { cliente, chamadas } = clienteComResposta(() =>
      respostaDeErro(400, 132001, 'template name does not exist'),
    );
    expect(await cliente.enviarTemplate(ENVIO)).toMatchObject({ falha: 'template_inexistente' });
    expect(chamadas()).toBe(1);
  });

  it('o detalhe junta a frase da Meta com a conduta nossa', async () => {
    const { cliente } = clienteComResposta(() =>
      respostaDeErro(400, 132001, 'template name does not exist'),
    );
    const r = await cliente.enviarTemplate(ENVIO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detalhe).toContain('template name does not exist');
      expect(r.detalhe).toContain('registrar-templates');
    }
  });

  it('o detalhe não leva o telefone do paciente nem o token', async () => {
    const { cliente } = clienteComResposta(() => respostaDeErro(400, 131026, 'undeliverable'));
    const r = await cliente.enviarTemplate(ENVIO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detalhe).not.toContain('5511999990000');
      expect(r.detalhe).not.toContain('token-falso-de-teste');
    }
  });

  it('limite repete e acaba desistindo, com a falha de limite', async () => {
    const { cliente, chamadas } = clienteComResposta(() =>
      respostaDeErro(429, 0, 'rate limit hit'),
    );
    expect(await cliente.enviarTemplate(ENVIO)).toMatchObject({
      motivo: 'temporario',
      falha: 'limite_de_envio',
    });
    // Uma tentativa mais os três backoffs.
    expect(chamadas()).toBe(4);
  });
});

class PortasFalsas implements PortasDoEnvio {
  readonly gravados: RegistroDeEnvio[] = [];
  constructor(
    private readonly numero: string | undefined,
    private readonly jaConhecidos: readonly string[] = [],
  ) {}

  resolverPhoneNumberId(): Promise<string | undefined> {
    return Promise.resolve(this.numero);
  }

  registrarEnvio(r: RegistroDeEnvio): Promise<{ novo: boolean }> {
    this.gravados.push(r);
    return Promise.resolve({ novo: !this.jaConhecidos.includes(r.wamid) });
  }
}

class ClienteFalso {
  readonly enviados: EnvioDeTemplate[] = [];
  constructor(private readonly resultado: ResultadoEnvio = { ok: true, wamid: 'wamid.ABC' }) {}

  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio> {
    this.enviados.push(p);
    return Promise.resolve(this.resultado);
  }
  enviarTexto(): Promise<ResultadoEnvio> {
    return Promise.resolve(this.resultado);
  }
  marcarDigitando(): Promise<void> {
    return Promise.resolve();
  }
}

describe('o envio de um template da clínica', () => {
  const params = {
    nome_paciente: 'Maria',
    nome_profissional: 'Dra. Helena',
    data_hora: 'terça, 14/10, às 14:30',
    nome_clinica: 'Clínica Modelo',
  };

  it('monta o payload com nome, idioma, variáveis na ordem e payloads de botão', async () => {
    const cliente = new ClienteFalso();
    const portas = new PortasFalsas('111222');
    const enviar = criarEnviadorDeTemplate(cliente, portas);

    const r = await enviar('clinica-1', '+5511999990000', 'confirmacaoConsulta', params);

    expect(r).toEqual({ ok: true, wamid: 'wamid.ABC', novo: true });
    expect(cliente.enviados[0]).toEqual({
      phoneNumberId: '111222',
      paraE164: '+5511999990000',
      template: 'fliqo_confirmacao_consulta',
      idioma: 'pt_BR',
      variaveis: ['Maria', 'Dra. Helena', 'terça, 14/10, às 14:30', 'Clínica Modelo'],
      botoes: ['CONFIRMAR_CONSULTA', 'REMARCAR_CONSULTA'],
    });
  });

  it('template sem variável e sem botão vai sem os dois campos', async () => {
    const cliente = new ClienteFalso();
    const enviar = criarEnviadorDeTemplate(cliente, new PortasFalsas('111222'));
    await enviar('clinica-1', '+5511999990000', 'lembreteFinal', {});
    expect(cliente.enviados[0]).toEqual({
      phoneNumberId: '111222',
      paraE164: '+5511999990000',
      template: 'lembrete_final',
      idioma: 'pt_BR',
    });
  });

  it('grava o wamid devolvido, com o nome da Meta e não a chave de código', async () => {
    const portas = new PortasFalsas('111222');
    const enviar = criarEnviadorDeTemplate(new ClienteFalso(), portas);
    await enviar('clinica-1', '+5511999990000', 'vagaLiberada', {
      nome_paciente: 'Maria',
      data_hora: 'quinta, 09:00',
      nome_clinica: 'Clínica Modelo',
    });
    expect(portas.gravados).toEqual([
      {
        clinicId: 'clinica-1',
        paraE164: '+5511999990000',
        template: 'fliqo_vaga_liberada',
        wamid: 'wamid.ABC',
      },
    ]);
  });

  it('wamid que já estava gravado volta com novo: false', async () => {
    const portas = new PortasFalsas('111222', ['wamid.ABC']);
    const enviar = criarEnviadorDeTemplate(new ClienteFalso(), portas);
    const r = await enviar('clinica-1', '+5511999990000', 'remarcacao', {
      nome_paciente: 'Maria',
      nome_clinica: 'Clínica Modelo',
    });
    expect(r).toEqual({ ok: true, wamid: 'wamid.ABC', novo: false });
  });

  it('clínica sem número conectado não chega na Meta', async () => {
    const cliente = new ClienteFalso();
    const enviar = criarEnviadorDeTemplate(cliente, new PortasFalsas(undefined));
    const r = await enviar('clinica-1', '+5511999990000', 'remarcacao', {
      nome_paciente: 'Maria',
      nome_clinica: 'Clínica Modelo',
    });
    expect(r).toMatchObject({ ok: false, recusa: 'clinica_sem_numero' });
    expect(cliente.enviados).toHaveLength(0);
  });

  it('parâmetro em branco é recusado antes de falar com a Meta', async () => {
    const cliente = new ClienteFalso();
    const portas = new PortasFalsas('111222');
    const enviar = criarEnviadorDeTemplate(cliente, portas);
    const r = await enviar('clinica-1', '+5511999990000', 'remarcacao', {
      nome_paciente: 'Maria',
      nome_clinica: '',
    });
    expect(r).toMatchObject({ ok: false, recusa: 'parametro_vazio' });
    expect(cliente.enviados).toHaveLength(0);
    expect(portas.gravados).toHaveLength(0);
  });

  it('falha definitiva da Meta volta com a falha tipada e repetir: false', async () => {
    const cliente = new ClienteFalso({
      ok: false,
      motivo: 'recusado',
      falha: 'template_inexistente',
      detalhe: 'não existe',
    });
    const portas = new PortasFalsas('111222');
    const r = await criarEnviadorDeTemplate(cliente, portas)(
      'clinica-1',
      '+5511999990000',
      'remarcacao',
      { nome_paciente: 'Maria', nome_clinica: 'Clínica Modelo' },
    );
    expect(r).toMatchObject({
      ok: false,
      recusa: 'meta',
      falha: 'template_inexistente',
      repetir: false,
    });
    // Nada a gravar: não houve wamid.
    expect(portas.gravados).toHaveLength(0);
  });

  it('falha temporária da Meta volta com repetir: true', async () => {
    const cliente = new ClienteFalso({
      ok: false,
      motivo: 'temporario',
      falha: 'limite_de_envio',
      detalhe: 'limite',
    });
    const r = await criarEnviadorDeTemplate(cliente, new PortasFalsas('111222'))(
      'clinica-1',
      '+5511999990000',
      'remarcacao',
      { nome_paciente: 'Maria', nome_clinica: 'Clínica Modelo' },
    );
    expect(r).toMatchObject({ recusa: 'meta', falha: 'limite_de_envio', repetir: true });
  });
});
