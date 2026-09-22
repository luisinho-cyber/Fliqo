/**
 * Servidor estático do que o `next build` exportou. Existe para o teste de ponta
 * a ponta rodar contra o site publicado de verdade, e não contra o modo de
 * desenvolvimento.
 *
 * Uso: node scripts/servir.mjs [porta]
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const porta = Number(process.argv[2] ?? 3100);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function resolver(caminho) {
  // normalize + prefixo impedem sair da pasta exportada com "..".
  const alvo = join(raiz, normalize(caminho));
  if (!alvo.startsWith(raiz)) return null;
  for (const tentativa of [alvo, `${alvo}.html`, join(alvo, 'index.html')]) {
    const info = await stat(tentativa).catch(() => null);
    if (info?.isFile()) return tentativa;
  }
  return null;
}

createServer((req, res) => {
  const caminho = decodeURIComponent((req.url ?? '/').split('?')[0]);
  void resolver(caminho === '/' ? '/index.html' : caminho).then((arquivo) => {
    if (arquivo === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('não encontrado');
      return;
    }
    res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' });
    createReadStream(arquivo).pipe(res);
  });
}).listen(porta, () => {
  console.log(`demo em http://127.0.0.1:${porta}`);
});
