import { describe, expect, it } from 'vitest';
import {
  OnboardingMeta,
  QUALIDADES,
  qualidadeDaMeta,
  redigirSegredos,
  type Qualidade,
} from '../src/onboarding';

/**
 * A borda com a Meta: o que ela conta sobre o número, e o que nunca pode sair
 * dela para um log ou para o banco.
 */

const SEGREDO = 'segredo-do-app';
const CODIGO = 'AQD-codigo-do-navegador-9f2';

interface Roteiro {
  verifiedName?: string;
  qualityRating?: string;
  erroNaTroca?: string;
}

function metaFalsa(roteiro: Roteiro = {}) {
  const buscar: typeof fetch = (entrada) => {
    const url = entrada instanceof Request ? entrada.url : entrada.toString();
    const responder = (status: number, corpo: unknown) =>
      Promise.resolve(new Response(JSON.stringify(corpo), { status }));

    if (url.includes('oauth/access_token')) {
      return roteiro.erroNaTroca === undefined
        ? responder(200, { access_token: 'TOKEN-DA-CLINICA' })
        : responder(400, { error: { message: roteiro.erroNaTroca } });
    }
    if (url.includes('me/businesses')) return responder(200, { data: [{ id: 'WABA-1' }] });
    if (url.includes('/phone_numbers')) {
      return responder(200, {
        data: [
          {
            id: 'PN-1',
            display_phone_number: '+5511999990000',
            ...(roteiro.verifiedName === undefined ? {} : { verified_name: roteiro.verifiedName }),
            ...(roteiro.qualityRating === undefined
              ? {}
              : { quality_rating: roteiro.qualityRating }),
          },
        ],
      });
    }
    return responder(200, {});
  };
  return new OnboardingMeta({ appId: 'app', appSecret: SEGREDO, buscar });
}

describe('qualidadeDaMeta', () => {
  it('traduz os valores oficiais da Cloud API', () => {
    expect(qualidadeDaMeta('GREEN')).toBe('verde');
    expect(qualidadeDaMeta('YELLOW')).toBe('amarelo');
    expect(qualidadeDaMeta('RED')).toBe('vermelho');
    expect(qualidadeDaMeta('UNKNOWN')).toBe('desconhecida');
  });

  it('valor que a Meta inventar cai em "desconhecida", não na coluna crua', () => {
    // A coluna tem lista fechada (0009). Gravar texto cru da Meta faria a
    // conexão falhar no insert, meses depois, por causa de um valor novo.
    expect(qualidadeDaMeta('CHARTREUSE')).toBe('desconhecida');
    expect(qualidadeDaMeta('green')).toBe('verde');
  });

  /**
   * Campo ausente é NÃO HAVER LEITURA. Virar 'desconhecida' criaria um carimbo
   * de agora para uma apuração que não houve — a tela diria "apurado hoje" sobre
   * nada.
   */
  it('campo ausente é undefined, e não "desconhecida"', () => {
    expect(qualidadeDaMeta(undefined)).toBeUndefined();
  });

  it('a lista traduzida cobre exatamente o que o tipo permite', () => {
    const todas: Qualidade[] = ['verde', 'amarelo', 'vermelho', 'desconhecida'];
    expect([...QUALIDADES].sort()).toEqual([...todas].sort());
  });
});

describe('o que a conexão traz do número', () => {
  it('nome verificado e qualidade vêm dos campos oficiais', async () => {
    const r = await metaFalsa({ verifiedName: 'Clínica Sorriso', qualityRating: 'GREEN' }).conectar(
      {
        codigo: CODIGO,
        pin: '123456',
      },
    );
    expect(r).toMatchObject({
      ok: true,
      nomeVerificado: 'Clínica Sorriso',
      qualidade: 'verde',
      phoneNumberId: 'PN-1',
    });
  });

  it('Meta calada não inventa valor: os dois campos ficam de fora', async () => {
    const r = await metaFalsa().conectar({ codigo: CODIGO, pin: '123456' });
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('nomeVerificado');
    expect(r).not.toHaveProperty('qualidade');
  });

  it('número já sabido não consulta, e por isso não carimba nada', async () => {
    // Sem consulta não há leitura. Sem leitura, sem carimbo — a tela diz que
    // não sabe, em vez de inventar um "apurado agora".
    const r = await metaFalsa({ qualityRating: 'GREEN' }).conectar({
      codigo: CODIGO,
      pin: '123456',
      phoneNumberId: 'PN-ESCOLHIDO',
    });
    expect(r).toMatchObject({ ok: true, phoneNumberId: 'PN-ESCOLHIDO' });
    expect(r).not.toHaveProperty('qualidade');
  });
});

describe('redigirSegredos', () => {
  it('apaga o valor listado e os pares chave=valor, com o = junto', () => {
    const texto = `falhou em https://x/oauth/access_token?client_secret=${SEGREDO}&code=abc`;
    const limpo = redigirSegredos(texto, [SEGREDO]);
    expect(limpo).not.toContain(SEGREDO);
    expect(limpo).not.toContain('client_secret=');
    expect(limpo).not.toContain('code=');
  });

  it('o código de autorização é credencial, e sai mesmo solto no texto', () => {
    // A regex de `code=` não alcança a Meta ecoando o valor por extenso
    // ("Invalid verification code: AQD-..."), e o código é trocável por token
    // enquanto não expira.
    const limpo = redigirSegredos(`Invalid verification code: ${CODIGO}`, [SEGREDO, CODIGO]);
    expect(limpo).not.toContain(CODIGO);
  });
});

describe('o código não escapa pelo detalhe do erro', () => {
  it('a Meta ecoando o código por extenso não o devolve para quem chamou', async () => {
    const onboarding = metaFalsa({ erroNaTroca: `Invalid verification code: ${CODIGO}` });
    const r = await onboarding.conectar({ codigo: CODIGO, pin: '123456' });

    expect(r).toMatchObject({ ok: false, motivo: 'codigo_invalido' });
    // O detalhe vai para last_error, para o evento de conexão e para o log.
    expect(JSON.stringify(r)).not.toContain(CODIGO);
  });

  it('e o segredo do app também não, mesmo com a URL ecoada', async () => {
    const onboarding = metaFalsa({
      erroNaTroca: `Bad request: client_secret=${SEGREDO}&code=${CODIGO}`,
    });
    const r = await onboarding.conectar({ codigo: CODIGO, pin: '123456' });
    const tudo = JSON.stringify(r);
    expect(tudo).not.toContain(SEGREDO);
    expect(tudo).not.toContain(CODIGO);
  });
});
