import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import {
  COOKIE_DA_SESSAO,
  NOME_CONFIRMADO,
  PRIMEIRO_CONFIRMADO,
  PRIMEIRO_SEM_CONFIRMAR,
  USUARIO,
} from './identidades';

/**
 * O painel renderizado, com sessão de verdade do ponto de vista do painel.
 *
 * A sessão é fabricada: um JWT assinado com o mesmo `SUPABASE_JWT_SECRET` que a API verifica,
 * embalado no formato de cookie do @supabase/ssr.
 *
 * O cookie sozinho NÃO basta, e isso é mérito do painel: o `proxy.ts` chama `getUser()`, que
 * valida o token contra o servidor de autenticação, porque `getSession()` sozinho acreditaria
 * em qualquer cookie. Então o e2e sobe um Supabase Auth falso que confere a assinatura — o
 * terceiro é mockado na borda HTTP, e a produção continua recusando sessão forjada.
 *
 * Por que não logar pela tela de login: o login é do Supabase Auth, um serviço de terceiro.
 * Testar o login deles aqui tornaria esta suíte dependente de rede e de um projeto real — e
 * o que este arquivo existe para provar é o PAINEL, não a autenticação deles.
 */

const JWT_SECRET = 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890';

/**
 * Base64 por `btoa`, e não por `Buffer.from`.
 *
 * A guarda de lint do painel proíbe `.from(` em apps/web — ela existe para impedir
 * `supabase.from('tabela')`, que é a regra 10 do CLAUDE.md, e `Buffer.from` cai nela por
 * coincidência de nome. Afrouxar a guarda para um teste passar seria trocar uma proteção
 * real por conveniência, então o teste é que se ajusta. O conteúdo é JSON ASCII (JWT, uuid,
 * palavras sem acento), que é o que `btoa` aceita.
 */
function paraBase64(texto: string): string {
  return btoa(texto);
}

async function comSessao(context: BrowserContext): Promise<void> {
  const agora = Math.floor(Date.now() / 1000);
  const access_token = await new SignJWT({ role: 'authenticated', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USUARIO)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));

  const sessao = {
    access_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: agora + 3600,
    refresh_token: 'refresh-que-nunca-e-usado',
    user: { id: USUARIO, aud: 'authenticated', role: 'authenticated' },
  };

  await context.addCookies([
    {
      name: COOKIE_DA_SESSAO,
      value: `base64-${paraBase64(JSON.stringify(sessao))}`,
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
}

/**
 * O login SEM query, que é o do `proxy.ts`.
 *
 * Existem duas guardas, e isso é bom: o proxy barra na borda e o `painel.ts` barra de novo
 * ao montar a página. Mas elas se distinguem pelo destino — o proxy manda para `/login`, a
 * página manda para `/login?erro=sessao`. Afirmar o destino exato é o que faz este teste
 * notar se o proxy parar de guardar: sem ele a pessoa ainda cai no login, pela segunda
 * camada, e um teste que aceitasse qualquer `/login` não veria a primeira desaparecer.
 *
 * O comentário do próprio proxy diz que é ALI que "sair da conta" e "token vencido" caem no
 * mesmo lugar. Este é o teste dessa frase.
 */
async function esperaLoginDoProxy(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/login$/);
}

test.describe('a tela Hoje com sessão', () => {
  test.beforeEach(async ({ context }) => {
    await comSessao(context);
  });

  /**
   * A guarda contra o falso verde deste arquivo.
   *
   * Sem ela, uma sessão que parasse de funcionar redirecionaria tudo para /login e os
   * `toBeVisible` abaixo falhariam por motivo certo — mas um teste escrito com
   * `not.toBeVisible` passaria para sempre. Esta primeira asserção é a que diz, em voz alta,
   * que estamos dentro.
   */
  test('entra de verdade: não é a tela de login', async ({ page }) => {
    await page.goto('/hoje');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('mostra os dois pacientes do dia, pelo primeiro nome', async ({ page }) => {
    await page.goto('/hoje');
    // `toBeVisible` espera: a tela Hoje chega em streaming, e `next dev` leva alguns
    // segundos para a primeira renderização. Ler o texto do corpo direto pegaria o
    // "montando o dia de hoje…" e falharia por pressa, não por defeito.
    await expect(page.getByText(PRIMEIRO_CONFIRMADO).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PRIMEIRO_SEM_CONFIRMAR).first()).toBeVisible({ timeout: 30_000 });
  });

  test('a tela abre com decisão, não com número solto', async ({ page }) => {
    // DESIGN.md: a primeira linha diz o que fazer. Uma consulta sem confirmação é dinheiro
    // em risco, e é a manchete que tem de nomear isso — não um cartão de indicador.
    await page.goto('/hoje');
    await expect(page.getByText(/sem confirmação/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/R\$/).first()).toBeVisible();
  });

  test('nenhum telefone completo de paciente aparece na página', async ({ page }) => {
    // A tela é de trabalho, não de cadastro, e fica num monitor que outro paciente vê.
    await page.goto('/hoje');
    await expect(page.getByText(PRIMEIRO_CONFIRMADO).first()).toBeVisible({ timeout: 30_000 });
    const corpo = await page.locator('body').innerText();
    expect(corpo).not.toContain('5511900000001');
    expect(corpo).not.toContain('5511900000002');
    // Nem o nome inteiro: a Linha do Dia mostra o primeiro nome de propósito.
    expect(corpo).not.toContain(NOME_CONFIRMADO);
  });
});

test.describe('sessão forjada não entra', () => {
  /**
   * O teste que prova a frase do `proxy.ts`.
   *
   * Lá está escrito que `getSession()` sozinho acreditaria em qualquer cookie, e que é por
   * isso que o painel chama `getUser()`. Esta é a prova: um cookie bem formado, com um JWT
   * de verdade, assinado com o segredo ERRADO. Se o painel acreditasse no cookie, ele
   * entraria.
   *
   * É também o teste que mantém honesto o Supabase falso: sem ele, um stub que aceitasse
   * qualquer token passaria despercebido, e a suíte estaria provando menos do que afirma.
   */
  test('cookie com token assinado por outro segredo cai no login', async ({ page, context }) => {
    const sub = USUARIO;
    const tokenForjado = await new SignJWT({ role: 'authenticated', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('ESTE_NAO_E_O_SEGREDO_DO_PAINEL_123456'));

    const sessao = {
      access_token: tokenForjado,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-forjado',
      user: { id: sub, aud: 'authenticated', role: 'authenticated' },
    };
    await context.addCookies([
      {
        name: COOKIE_DA_SESSAO,
        value: `base64-${paraBase64(JSON.stringify(sessao))}`,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.goto('/hoje');
    await esperaLoginDoProxy(page);
    await expect(page.getByText(PRIMEIRO_CONFIRMADO)).toHaveCount(0);
  });
});

test.describe('sem sessão', () => {
  test('a tela Hoje manda para o login em vez de mostrar agenda', async ({ page }) => {
    // O par do teste de guarda acima: prova que o cookie é o que está destravando a página,
    // e não uma rota aberta por acidente.
    await page.goto('/hoje');
    await esperaLoginDoProxy(page);
    await expect(page.getByText(PRIMEIRO_CONFIRMADO)).toHaveCount(0);
  });
});
