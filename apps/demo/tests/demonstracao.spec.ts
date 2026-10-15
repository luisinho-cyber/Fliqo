import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * A demonstração é usada ao vivo, na frente de um cliente, e roda sem banco e
 * sem Meta. O teste toca nos mesmos botões que quem apresenta toca e falha se
 * aparecer qualquer erro no console — numa apresentação, erro no console costuma
 * chegar antes como tela em branco.
 *
 * Cada bloco abaixo é um dos seis itens que a demonstração mostra, na ordem em
 * que eles aparecem.
 */

function vigiarConsole(page: Page): string[] {
  const erros: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') erros.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e: Error) => erros.push(`pageerror: ${e.message}`));
  return erros;
}

/**
 * A tipografia vem do Google Fonts em produção. No teste ela é servida vazia: o
 * que se mede aqui é o comportamento da demonstração, não a rede de terceiros.
 */
async function semFontesDeFora(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (rota) =>
    rota.fulfill({ status: 200, contentType: 'font/woff2', body: '' }),
  );
}

async function abrir(page: Page): Promise<string[]> {
  const erros = vigiarConsole(page);
  await semFontesDeFora(page);
  await page.goto('/');
  await expect(page.getByTestId('linha-do-dia')).toBeVisible();
  return erros;
}

const HORA = /^\d{2}:\d{2}$/;

test('os três toques gravam chegada, início e fim', async ({ page }) => {
  const erros = await abrir(page);

  // Lucas ainda não chegou: só o primeiro toque está de pé.
  await page.getByTestId('bloco-a5').click();
  await expect(page.getByTestId('instante-chegou')).toHaveText('—');
  await expect(page.getByTestId('toque-iniciar')).toBeDisabled();
  await expect(page.getByTestId('motivo')).toContainText('ainda não chegou');

  await page.getByTestId('toque-chegou').click();
  await expect(page.getByTestId('instante-chegou')).toHaveText(HORA);
  await expect(page.getByTestId('toque-chegou')).toBeDisabled();

  await page.getByTestId('toque-iniciar').click();
  await expect(page.getByTestId('instante-iniciou')).toHaveText(HORA);

  await page.getByTestId('toque-finalizar').click();
  await expect(page.getByTestId('instante-finalizou')).toHaveText(HORA);
  // Finalizar é o que torna a consulta realizada, e o bloco passa a ler assim.
  await expect(page.getByTestId('bloco-a5')).toHaveClass(/finalizada/);

  expect(erros).toEqual([]);
});

test('a linha do agora marca este minuto, em âmbar', async ({ page }) => {
  const erros = await abrir(page);

  const agora = page.getByTestId('agora-ana');
  await expect(agora).toBeVisible();

  // A etiqueta é a hora do relógio de quem está olhando, não uma hora congelada.
  const doNavegador = await page.evaluate(() =>
    new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  );
  await expect(agora).toContainText(doNavegador);

  const cor = await agora.evaluate((el) => getComputedStyle(el).backgroundColor);
  const ambar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--agora').trim(),
  );
  expect(ambar).not.toBe('');
  // A cor sai do token: nenhum componente carrega cor literal.
  expect(cor).toBe(await paraRgb(page, ambar));

  expect(erros).toEqual([]);
});

async function paraRgb(page: Page, cor: string): Promise<string> {
  return page.evaluate((valor) => {
    const d = document.createElement('div');
    d.style.color = valor;
    document.body.appendChild(d);
    const rgb = getComputedStyle(d).color;
    d.remove();
    return rgb;
  }, cor);
}

test('horário livre é hachura, nunca branco', async ({ page }) => {
  const erros = await abrir(page);

  // O fundo da faixa é a hachura: todo horário sem bloco é horário livre.
  const fundo = await page
    .getByTestId('trilho-paulo')
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(fundo).toContain('repeating-linear-gradient');

  // Helena cancelou na véspera, então o horário dela não desenha bloco nenhum:
  // o que ficou ali é horário disponível, e é isso que a hachura diz.
  await expect(page.getByTestId('bloco-p4')).toHaveCount(0);

  expect(erros).toEqual([]);
});

test('o bloco atrasado desloca, e o horário marcado fica tracejado no lugar', async ({ page }) => {
  const erros = await abrir(page);

  // Patrícia está marcada para as 2h40 de jornada, mas a Camila ainda está em
  // atendimento: o bloco dela começa depois, e o tracejado fica onde ela estava.
  const marcado = page.getByTestId('marcado-a4');
  await expect(marcado).toBeAttached();
  await expect(page.getByTestId('bloco-a4')).toHaveClass(/deslocado/);

  const traco = await marcado.evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(traco).toBe('dashed');

  // A distância entre o tracejado e o bloco é o atraso: ela tem de ser > 0.
  const caixas = await page.evaluate(() => {
    const tracejado = document.querySelector('[data-testid="marcado-a4"]');
    const bloco = document.querySelector('[data-testid="bloco-a4"]');
    if (!tracejado || !bloco) return null;
    return {
      tracejado: tracejado.getBoundingClientRect().left,
      bloco: bloco.getBoundingClientRect().left,
    };
  });
  expect(caixas).not.toBeNull();
  expect(caixas?.bloco ?? 0).toBeGreaterThan(caixas?.tracejado ?? 0);

  // O buraco da agenda absorve o atraso: Sofia, depois do intervalo, não desloca.
  await expect(page.getByTestId('marcado-a6')).toHaveCount(0);

  expect(erros).toEqual([]);
});

test('a confirmação mostra quem respondeu e quem não respondeu', async ({ page }) => {
  const erros = await abrir(page);
  await page.getByTestId('aba-confirmacao').click();

  await expect(page.getByTestId('confirmacao-a5')).toContainText('respondeu que vem');
  await expect(page.getByTestId('confirmacao-p4')).toContainText('respondeu que não vem');
  await expect(page.getByTestId('confirmacao-p5')).toContainText('não respondeu');

  // Silêncio não é cancelamento: o horário de quem não respondeu continua marcado.
  await expect(page.getByTestId('resumo-confirmacao')).toContainText('silêncio não é cancelamento');
  await page.getByTestId('aba-dia').click();
  await expect(page.getByTestId('bloco-p5')).toBeVisible();

  // A conversa é a de verdade: pergunta da clínica, resposta do paciente.
  await page.getByTestId('aba-confirmacao').click();
  await page.getByTestId('confirmacao-a3').getByRole('button').click();
  await expect(page.getByTestId('mensagens')).toContainText('Podemos confirmar?');
  await expect(page.getByTestId('mensagens')).toContainText('Confirmo');

  expect(erros).toEqual([]);
});

test('a vaga liberada é oferecida e reocupada', async ({ page }) => {
  const erros = await abrir(page);

  await page.getByTestId('aba-espera').click();
  await expect(page.getByTestId('estado-da-oferta')).toContainText('Nenhuma vaga aberta');
  await expect(page.getByTestId('espera-w1')).toContainText('na fila');

  // Marina responde que não vem. O horário dela abre e a oferta sai em lote.
  await page.getByRole('button', { name: 'Não vou poder' }).click();
  await expect(page.getByTestId('estado-da-oferta')).toContainText('Oferta aberta para 3');
  await expect(page.getByTestId('espera-w1')).toContainText('oferta enviada');
  await expect(page.getByTestId('espera-w3')).toContainText('oferta enviada');
  // A fila é por procedimento: quem espera profilaxia não recebe oferta de toxina.
  await expect(page.getByTestId('espera-w4')).toContainText('na fila');

  // Enquanto ninguém aceitou, o horário está livre: nenhum bloco no lugar.
  await page.getByTestId('aba-dia').click();
  await expect(page.getByTestId('bloco-a7')).toHaveCount(0);

  // Mariana responde primeiro e fica com o horário.
  await page.getByRole('button', { name: 'Quero este horário' }).click();
  await expect(page.getByTestId('bloco-a7-reocupada')).toBeVisible();
  await expect(page.getByTestId('bloco-a7-reocupada')).toContainText('Mariana');

  await page.getByTestId('aba-espera').click();
  await expect(page.getByTestId('espera-w1')).toContainText('ficou com a vaga');
  // Quem não ficou com a vaga não sai da fila.
  await expect(page.getByTestId('espera-w2')).toContainText('segue na fila');
  await expect(page.getByTestId('estado-da-oferta')).toContainText('Nenhuma vaga aberta');

  expect(erros).toEqual([]);
});

test('o que está mockado diz que está, e nenhuma tela rola para o lado', async ({ page }) => {
  const erros = await abrir(page);

  // "ilustração" na tela, visível, não em comentário.
  await expect(page.getByTestId('ilustracao').first()).toBeVisible();
  await expect(page.getByTestId('celular')).toContainText('ilustração');

  for (const aba of ['confirmacao', 'espera', 'dia']) {
    await page.getByTestId(`aba-${aba}`).click();
    await expect(page.locator('.painel')).toBeVisible();
    await expect(page.getByTestId('ilustracao').first()).toBeVisible();
    // Rolagem lateral em tela de celular é o jeito mais rápido de a demonstração
    // parecer quebrada na frente do cliente.
    const largura = await page.evaluate(() => ({
      conteudo: document.documentElement.scrollWidth,
      tela: document.documentElement.clientWidth,
    }));
    expect(largura.conteudo, `a tela "${aba}" rola para o lado`).toBeLessThanOrEqual(largura.tela);
  }

  // Nada do que ficou de fora voltou pela porta dos fundos.
  await expect(page.getByTestId('aba-caixa')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Pontualidade');
  await expect(page.locator('.rodape')).toContainText('dados fictícios');

  expect(erros).toEqual([]);
});
