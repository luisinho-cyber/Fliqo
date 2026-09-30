/**
 * Health check do painel.
 *
 * Existe porque o Railway precisa de uma rota que responda 200 sem sessão: a raiz
 * do painel manda para /login, que é 307, e um health check que segue redirecionamento
 * não diz nada sobre o serviço estar de pé.
 *
 * Fica FORA do `proxy.ts` (veja o `matcher` lá), e por isso é pública. Não devolve
 * nada além de que o processo respondeu — nenhum dado, nenhuma versão, nenhuma
 * variável de ambiente. Health check que conta o que está configurado é
 * reconhecimento de graça para quem varre a internet.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}
