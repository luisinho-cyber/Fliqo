import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { webhookRoutes } from './routes/webhooks';
import { dashboardRoutes } from './routes/dashboard';

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  // rawBody preservado para validacao HMAC — NUNCA remover
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
  }));

  app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true }));
  app.use('/webhooks', webhookRoutes);
  app.use('/api/dashboard', dashboardRoutes); // TODO: middleware de auth JWT antes do piloto

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // 404 e handler global — nunca vazar stack trace
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[unhandled]', err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
