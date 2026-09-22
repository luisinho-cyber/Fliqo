import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * A demonstração é usada ao vivo, na frente de um cliente. O teste roda as seis
 * cenas na ordem, tocando nos mesmos botões que quem apresenta toca, e falha se
 * aparecer qualquer erro no console.
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
 * A tipografia vem do Google Fonts em produção. No teste ela é servida vazia:
 * o que se mede aqui é o comportamento da demonstração, não a rede de terceiros.
 */
async function semFontesDeFora(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (rota) =>
    rota.fulfill({ status: 200, contentType: 'font/woff2', body: '' }),
  );
}

async function abrir(page: Page, caminho = '/'): Promise<string[]> {
  const erros = vigiarConsole(page);
  await semFontesDeFora(page);
  await page.goto(caminho);
  await expect(page.getByTestId('manchete')).toBeVisible();
  return erros;
}

const avancar = (page: Page) => page.getByTestId('avancar').click();

test('as seis cenas rodam do começo ao fim', async ({ page }) => {
  const erros = await abrir(page);

  // 1. Confirmação de véspera: a paciente responde que não vem e o horário abre.
  await avancar(page);
  await expect(page.getByTestId('celular')).toContainText('Podemos confirmar?');
  await expect(page.getByTestId('bloco-t3')).toBeVisible();
  await page.getByRole('button', { name: 'Não vou' }).click();
  await expect(page.getByTestId('livre-t3')).toBeVisible();
  await expect(page.getByTestId('decisoes')).toContainText('ficou livre');

  // 2. Lista de espera: a vaga vai para três pessoas e a primeira fica com ela.
  await avancar(page);
  await expect(page.getByTestId('lista-de-espera')).toBeVisible();
  await expect(page.getByTestId('espera-w1')).toContainText('oferta enviada');
  await page.getByRole('button', { name: 'Quero este horário' }).click();
  // A cena leva de volta para a linha do dia: a vaga virou consulta confirmada.
  await expect(page.getByTestId('bloco-t9')).toBeVisible();
  await expect(page.getByTestId('recuperado')).toContainText('R$');
  await page.getByTestId('aba-fila').click();
  await expect(page.getByTestId('espera-w1')).toContainText('ficou com a vaga');
  await expect(page.getByTestId('espera-w2')).toContainText('segue na fila');

  // 3. Fora do expediente: paciente novo marca sozinho, às 22h.
  await avancar(page);
  await expect(page.getByTestId('conversas')).toBeVisible();
  await expect(page.getByTestId('celular')).toContainText('Quanto custa uma limpeza?');
  await page.getByRole('button', { name: 'Quinta, 10:00' }).click();
  await expect(page.getByTestId('celular')).toContainText('Marcado: profilaxia');
  await page.getByRole('button', { name: 'Pode sim' }).click();
  await expect(page.getByTestId('aviso')).toContainText('Autorização para lembretes');

  // 4. Atraso: quem está em casa recebe o novo horário; quem chegou, a recepção atende.
  await avancar(page);
  await expect(page.getByTestId('linha-do-dia')).toBeVisible();
  await expect(page.getByTestId('decisoes')).toContainText('min de atraso');
  await expect(page.getByTestId('decisoes')).toContainText('na recepção');
  await expect(page.getByTestId('celular')).toContainText('minutos de atraso');

  // 5. A assistente sai e chama gente.
  await avancar(page);
  await expect(page.getByTestId('celular')).toContainText('assistente pausada');
  await expect(page.getByTestId('decisoes')).toContainText('precisa falar com alguém da equipe');

  // 6. O que o dono vê.
  await avancar(page);
  await expect(page.getByTestId('caixa')).toBeVisible();
  await expect(page.getByTestId('grafico-caixa')).toBeVisible();
  await expect(page.getByTestId('perda-ano')).toContainText('R$');

  await expect(page.getByTestId('avancar')).toBeDisabled();
  expect(erros).toEqual([]);
});

test('a barra do apresentador responde ao teclado', async ({ page }) => {
  const erros = await abrir(page);

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('apresentador')).toContainText('O horário não fica vazio');

  await page.keyboard.press('r');
  await expect(page.getByTestId('apresentador')).toContainText('Confirmação de véspera');
  await expect(page.getByTestId('celular')).toContainText('A conversa aparece aqui');

  await page.keyboard.press('h');
  await expect(page.getByTestId('apresentador')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.getByTestId('apresentador')).toBeVisible();

  expect(erros).toEqual([]);
});

test('a calculadora lê os números da URL', async ({ page }) => {
  const erros = await abrir(page, '/?consultas=500&falta=20&ticket=800');
  await page.getByTestId('aba-caixa').click();

  await expect(page.getByTestId('calc-consultas')).toHaveValue('500');
  await expect(page.getByTestId('calc-falta')).toHaveValue('20');
  await expect(page.getByTestId('calc-ticket')).toHaveValue('800');

  // 500 × 20% = 100 faltas por mês × R$ 800 × 12 meses.
  await expect(page.getByTestId('perda-ano')).toHaveText('R$ 960.000,00');
  await expect(page.getByTestId('recuperado-ano')).toHaveText('R$ 576.000,00');

  expect(erros).toEqual([]);
});

test('todas as telas abrem sem erro e sem rolagem lateral', async ({ page }) => {
  const erros = await abrir(page);
  for (const aba of ['conversas', 'fila', 'caixa', 'pontualidade', 'dia']) {
    await page.getByTestId(`aba-${aba}`).click();
    await expect(page.locator('.painel').first()).toBeVisible();
    // Rolagem lateral em tela de celular é o jeito mais rápido de a demonstração
    // parecer quebrada na frente do cliente.
    const largura = await page.evaluate(() => ({
      conteudo: document.documentElement.scrollWidth,
      tela: document.documentElement.clientWidth,
    }));
    expect(largura.conteudo, `a tela "${aba}" rola para o lado`).toBeLessThanOrEqual(largura.tela);
  }
  await expect(page.getByTestId('pontualidade')).toBeHidden();
  await expect(page.locator('.rodape')).toContainText('dados fictícios');
  expect(erros).toEqual([]);
});
