import { describe, expect, it } from 'vitest';
import {
  causasAtivas,
  CAUSAS_DE_OPERADOR,
  decidirEnvio,
  dentroDoHorarioDeOperacao,
  frasesDoAviso,
  HORAS_DE_SILENCIO,
  INTERVALO_DE_REENVIO_MIN,
  MINUTOS_DE_WHATSAPP_FORA,
  TETO_DE_REENVIOS,
  type SaudeDaClinica,
} from '../src/operador';

const AGORA = new Date('2026-10-14T17:00:00Z'); // quarta, 14:00 em São Paulo

/** Clínica saudável: é o ponto de partida de todo caso, e nenhuma causa sai dela. */
const SAUDAVEL: SaudeDaClinica = {
  clinicId: 'c1',
  clinicaNome: 'Clínica Modelo',
  whatsappForaDesde: null,
  enviadasNaUltimaHora: 12,
  enviadasNaJanela: 30,
  vencidasNaJanela: 30,
  qualidade: 'verde',
};

function minutosAtras(min: number): Date {
  return new Date(AGORA.getTime() - min * 60_000);
}

describe('os limites são fixados por valor', () => {
  it('vinte minutos de carência, três horas de silêncio', () => {
    // Fixados por valor e não lidos da constante: o teste tem de cair quando o número muda,
    // porque mudar a carência muda quando o fundador é acordado.
    expect(MINUTOS_DE_WHATSAPP_FORA).toBe(20);
    expect(HORAS_DE_SILENCIO).toBe(3);
  });

  it('teto de seis reenvios, um por hora', () => {
    expect(TETO_DE_REENVIOS).toBe(6);
    expect(INTERVALO_DE_REENVIO_MIN).toBe(60);
  });

  it('são três causas, e a lista é fechada', () => {
    expect([...CAUSAS_DE_OPERADOR]).toEqual(['whatsapp_fora', 'silencio', 'qualidade']);
  });
});

describe('clínica saudável não acorda ninguém', () => {
  it('nenhuma causa', () => {
    expect(causasAtivas(SAUDAVEL, AGORA)).toEqual([]);
  });

  it('qualidade nunca medida não é qualidade ruim', () => {
    // `null` é número novo, que a Meta ainda não avaliou. Tratar como ruim geraria um e-mail
    // no primeiro dia de toda clínica.
    expect(causasAtivas({ ...SAUDAVEL, qualidade: null }, AGORA)).toEqual([]);
  });
});

describe('WhatsApp fora, com carência', () => {
  it('dezenove minutos ainda não valem e-mail', () => {
    // Queda que se resolve sozinha em dez minutos não precisa acordar ninguém, e o alerta na
    // tela da clínica já apareceu.
    const s = { ...SAUDAVEL, whatsappForaDesde: minutosAtras(19) };
    expect(causasAtivas(s, AGORA)).toEqual([]);
  });

  it('exatamente vinte minutos valem', () => {
    const s = { ...SAUDAVEL, whatsappForaDesde: minutosAtras(20) };
    expect(causasAtivas(s, AGORA)).toEqual(['whatsapp_fora']);
  });

  it('quarenta minutos valem, e a frase diz quantos', () => {
    const s = { ...SAUDAVEL, whatsappForaDesde: minutosAtras(40) };
    const frases = frasesDoAviso(s, causasAtivas(s, AGORA), AGORA);
    expect(frases[0]).toContain('40 min');
    expect(frases[0]).toContain('Configurações');
  });
});

describe('silêncio só conta se havia o que mandar', () => {
  it('clínica com ação vencida e zero envio dispara', () => {
    const s = { ...SAUDAVEL, enviadasNaJanela: 0, vencidasNaJanela: 4 };
    expect(causasAtivas(s, AGORA)).toEqual(['silencio']);
  });

  it('clínica SEM nada marcado não dispara, mesmo com zero envio', () => {
    // Fim de semana, feriado, clínica nova: zero mensagem é o certo, não o errado. Sem esta
    // condição, toda clínica sem consulta viraria alerta e o aviso perderia o significado.
    const s = { ...SAUDAVEL, enviadasNaJanela: 0, vencidasNaJanela: 0 };
    expect(causasAtivas(s, AGORA)).toEqual([]);
  });

  it('uma mensagem só já tira do silêncio', () => {
    // O sinal é "parou de mandar", não "mandou pouco". Volume é outra pergunta.
    const s = { ...SAUDAVEL, enviadasNaJanela: 1, vencidasNaJanela: 40 };
    expect(causasAtivas(s, AGORA)).toEqual([]);
  });
});

describe('qualidade fora do verde', () => {
  it('amarelo e vermelho disparam', () => {
    for (const q of ['amarelo', 'vermelho']) {
      expect(causasAtivas({ ...SAUDAVEL, qualidade: q }, AGORA)).toEqual(['qualidade']);
    }
  });

  it('desconhecida também, porque é a Meta dizendo que não sabe de um número ativo', () => {
    expect(causasAtivas({ ...SAUDAVEL, qualidade: 'desconhecida' }, AGORA)).toEqual(['qualidade']);
  });

  it('a frase diz o que está em risco', () => {
    const s = { ...SAUDAVEL, qualidade: 'vermelho' };
    expect(frasesDoAviso(s, ['qualidade'], AGORA)[0]).toContain('perde o direito de enviar');
  });
});

describe('três causas ao mesmo tempo viram um e-mail com três frases', () => {
  it('as causas saem na ordem da lista, não na ordem do acaso', () => {
    const s: SaudeDaClinica = {
      ...SAUDAVEL,
      whatsappForaDesde: minutosAtras(30),
      enviadasNaJanela: 0,
      vencidasNaJanela: 5,
      qualidade: 'vermelho',
    };
    expect(causasAtivas(s, AGORA)).toEqual(['whatsapp_fora', 'silencio', 'qualidade']);
    expect(frasesDoAviso(s, causasAtivas(s, AGORA), AGORA)).toHaveLength(3);
  });
});

describe('o reenvio, com teto', () => {
  it('primeira vez sempre manda', () => {
    expect(decidirEnvio(undefined, AGORA)).toEqual({ enviar: true, motivo: 'primeira_vez' });
  });

  it('cinquenta e nove minutos depois, cala', () => {
    const r = decidirEnvio({ envios: 1, ultimoEnvioEm: minutosAtras(59) }, AGORA);
    expect(r).toEqual({ enviar: false, motivo: 'muito_recente' });
  });

  it('sessenta minutos depois, reenvia', () => {
    const r = decidirEnvio({ envios: 1, ultimoEnvioEm: minutosAtras(60) }, AGORA);
    expect(r).toEqual({ enviar: true, motivo: 'reenvio' });
  });

  it('no sexto envio para, mesmo com a causa de pé', () => {
    // Se depois de seis horas de aviso ninguém olhou, o problema não é falta de e-mail — e
    // alerta que se repete para sempre vira filtro de caixa de entrada.
    const r = decidirEnvio({ envios: TETO_DE_REENVIOS, ultimoEnvioEm: minutosAtras(600) }, AGORA);
    expect(r).toEqual({ enviar: false, motivo: 'teto_atingido' });
  });

  it('o teto vence o intervalo: não existe reenvio depois dele', () => {
    const r = decidirEnvio({ envios: 99, ultimoEnvioEm: minutosAtras(100_000) }, AGORA);
    expect(r.enviar).toBe(false);
  });
});

describe('horário em que o operador aceita ser avisado', () => {
  const fuso = 'America/Sao_Paulo';

  it('quarta às 14h: sim', () => {
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-14T17:00:00Z'), fuso)).toBe(true);
  });

  it('quarta às 3h da manhã: não', () => {
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-14T06:00:00Z'), fuso)).toBe(false);
  });

  it('as bordas: 8h entra, 20h não', () => {
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-14T11:00:00Z'), fuso)).toBe(true);
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-14T23:00:00Z'), fuso)).toBe(false);
  });

  it('sábado e domingo: não', () => {
    // 17 e 18 de outubro de 2026 são sábado e domingo.
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-17T17:00:00Z'), fuso)).toBe(false);
    expect(dentroDoHorarioDeOperacao(new Date('2026-10-18T17:00:00Z'), fuso)).toBe(false);
  });

  it('o fuso é o do operador: a mesma hora UTC muda o veredito', () => {
    // 23:00 UTC de quarta é 20:00 em São Paulo (fora) e 11:00 em Auckland (dentro).
    const instante = new Date('2026-10-14T23:00:00Z');
    expect(dentroDoHorarioDeOperacao(instante, 'America/Sao_Paulo')).toBe(false);
    expect(dentroDoHorarioDeOperacao(instante, 'Pacific/Auckland')).toBe(true);
  });
});

describe('nada que o aviso diz identifica paciente', () => {
  it('as frases não têm telefone, id nem conteúdo de mensagem', () => {
    // A regra do retorno agregado vale para o TEXTO também: o e-mail sai da caixa de entrada
    // do operador para o celular dele, e dado de paciente não tem o que fazer lá.
    const s: SaudeDaClinica = {
      ...SAUDAVEL,
      whatsappForaDesde: minutosAtras(30),
      enviadasNaJanela: 0,
      vencidasNaJanela: 5,
      qualidade: 'vermelho',
    };
    const texto = frasesDoAviso(s, causasAtivas(s, AGORA), AGORA).join(' ');
    expect(texto).not.toMatch(/\+?55\d{8,}/);
    expect(texto).not.toMatch(/wamid/i);
    expect(texto).not.toMatch(/paciente [A-Z]/);
  });
});
