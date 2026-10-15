/**
 * Gera public/compartilhar.png (1200×630) com o mesmo desenho da Linha do Dia.
 * Fica como script, e não como imagem solta no repositório, para que a imagem
 * continue igual à tela quando os tokens do DESIGN.md mudarem.
 *
 * Uso: node scripts/imagem-de-compartilhamento.mjs
 * CHROMIUM_EXECUTAVEL aponta para um Chromium já instalado, quando não se quer
 * o que o Playwright baixa.
 */
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, '..');

const tokens = await readFile(join(raiz, 'app', 'tokens.css'), 'utf8');

const pagina = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" />
<style>
${tokens}
* { box-sizing: border-box; }
body { margin: 0; width: 1200px; height: 630px; background: var(--ground);
  color: var(--ink); font-family: var(--fonte-texto); display: flex; flex-direction: column;
  justify-content: space-between; padding: 60px 72px; }
.marca { font-family: var(--fonte-titulo); font-weight: 800; font-size: 34px; letter-spacing: -0.04em; }
.marca i { color: var(--agora); font-style: normal; }
h1 { font-family: var(--fonte-titulo); font-weight: 700; font-size: 58px; line-height: 1.08;
  letter-spacing: -0.035em; margin: 26px 0 0; max-width: 19ch; }
.trilho { position: relative; height: 86px; width: 1034px; border: 1px solid var(--fio);
  border-radius: 12px; background-color: var(--paper); margin-top: 34px; overflow: hidden;
  background-image: repeating-linear-gradient(45deg, var(--hachura) 0 1px, transparent 1px 8px); }
.bloco { position: absolute; top: 18px; height: 50px; border-radius: 8px; padding: 8px 12px;
  font-size: 15px; font-weight: 600; background: var(--ok-tinta); border: 1.5px solid var(--ok); }
.bloco.deslocado { background: var(--agora-tinta); border-color: var(--agora); }
.bloco .h { font-family: var(--fonte-mono); font-variant-numeric: tabular-nums; font-weight: 500; }
.marcado { position: absolute; top: 18px; height: 50px; border-radius: 8px;
  border: 1.5px dashed var(--agora); }
.nota { color: var(--ink-2); font-size: 21px; line-height: 1.45; margin: 26px 0 0; max-width: 62ch; }
.rodape { color: var(--ink-2); font-size: 19px; display: flex; justify-content: space-between; }
</style></head>
<body>
  <div>
    <span class="marca">fliqo<i>.</i></span>
    <h1>A agenda da clínica que não perde horário.</h1>
    <div class="trilho">
      <div class="bloco" style="left:20px;width:190px"><span class="h">09:02</span> Beatriz</div>
      <div class="bloco" style="left:226px;width:224px"><span class="h">10:00</span> Rafael</div>
      <div class="marcado" style="left:466px;width:134px"></div>
      <div class="bloco deslocado" style="left:618px;width:190px"><span class="h">11:06</span> Camila</div>
      <div class="bloco deslocado" style="left:824px;width:190px"><span class="h">12:01</span> Lucas</div>
    </div>
  <p class="nota">O contorno tracejado é o horário marcado. O bloco cheio é quando o paciente vai
  ser atendido de verdade, e a distância entre os dois é o atraso.</p>
  </div>
  <div class="rodape"><span>Confirmação pelo WhatsApp e lista de espera no mesmo lugar.</span>
  <span>Ambiente de demonstração · dados fictícios</span></div>
</body></html>`;

const arquivoHtml = join(await mkdtemp(join(tmpdir(), 'fliqo-og-')), 'compartilhar.html');
await mkdir(join(raiz, 'public'), { recursive: true });
await writeFile(arquivoHtml, pagina, 'utf8');

const executavel = process.env.CHROMIUM_EXECUTAVEL;
const navegador = await chromium.launch(executavel ? { executablePath: executavel } : {});
const aba = await navegador.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await aba.goto(`file://${arquivoHtml}`);
await aba.evaluate(() => document.fonts.ready);
const temFonte = await aba.evaluate(() => document.fonts.check('700 58px "Sora"'));
if (!temFonte)
  throw new Error(
    'A tipografia da demonstração não carregou; a imagem sairia com outra tipografia.',
  );
await aba.screenshot({ path: join(raiz, 'public', 'compartilhar.png') });
await navegador.close();
console.log('public/compartilhar.png gerado');
