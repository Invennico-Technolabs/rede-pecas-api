import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Captures the exact request bytes before JSON parsing (wired in via
 * `express.json({ verify })` in app.ts) — the HMAC must be computed over the
 * raw payload Meta signed, not a re-serialized `req.body`.
 */
export function captureRawBody(req: RawBodyRequest, _res: Response, buf: Buffer): void {
  req.rawBody = buf;
}

/**
 * Rejects webhook POSTs whose `X-Hub-Signature-256` header doesn't match an
 * HMAC-SHA256 of the raw body keyed with the Meta app secret. Without this,
 * anyone who discovers the webhook URL can forge inbound messages — including
 * admin approve/reject button taps, since admin identity is resolved from the
 * sender phone in the (unauthenticated) payload.
 *
 * Responds with a bare 401 rather than the admin JSON envelope, consistent
 * with the webhook's Meta-facing contract. Skipped (with a boot-time warning
 * from config.ts) only when WHATSAPP_APP_SECRET is unset outside production.
 */
export function verifyWhatsAppSignature(req: RawBodyRequest, res: Response, next: NextFunction): void {
  const appSecret = config.whatsapp.appSecret;
  if (!appSecret) return next();

  const header = req.headers['x-hub-signature-256'];
  if (typeof header !== 'string' || !header.startsWith('sha256=') || !req.rawBody) {
    logger.warn('[WEBHOOK] Rejected request with missing signature header or body');
    res.sendStatus(401);
    return;
  }

  const expected = createHmac('sha256', appSecret).update(req.rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');

  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    logger.warn('[WEBHOOK] Rejected request with invalid signature');
    res.sendStatus(401);
    return;
  }

  next();
}
