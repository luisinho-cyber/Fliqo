import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Valida assinatura HMAC SHA256 da Meta (WhatsApp/Instagram).
 * OBRIGATORIO: usar req.rawBody (Buffer bruto), nunca JSON.stringify —
 * re-serializar muda ordem/espacos e quebra o hash.
 * Comparacao em tempo constante (timingSafeEqual) contra timing attacks.
 */
export function verifyMetaSignature(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (typeof signature !== 'string' || !rawBody) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(403).json({ error: 'invalid signature' });
    }
    return next();
  };
}

export const verifyWhatsAppSignature = verifyMetaSignature(env.WHATSAPP_APP_SECRET);
