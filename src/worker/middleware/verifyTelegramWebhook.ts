import { Context, Next } from 'hono';
import { Env } from '../types/bindings';
import { constantTimeSecretMatch } from '../lib/crypto';

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024; // 256 KB

export interface WebhookContextVariables {
  rawWebhookBody: string;
}

export async function verifyTelegramWebhookMiddleware(
  c: Context<{ Bindings: Env; Variables: WebhookContextVariables }>,
  next: Next
): Promise<Response | void> {
  // 1. Authenticate webhook secret BEFORE reading body
  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!providedSecret) {
    return c.json({ ok: false, error: 'Unauthorized: Missing secret token' }, 401);
  }

  const currentMatch = await constantTimeSecretMatch(
    providedSecret,
    c.env.TELEGRAM_WEBHOOK_SECRET
  );

  let previousMatch = false;
  if (!currentMatch && c.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS) {
    previousMatch = await constantTimeSecretMatch(
      providedSecret,
      c.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS
    );
  }

  if (!currentMatch && !previousMatch) {
    return c.json({ ok: false, error: 'Unauthorized: Invalid secret token' }, 401);
  }

  // 2. Fast-reject oversized Content-Length header
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isNaN(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ ok: false, error: 'Payload Too Large' }, 413);
    }
  }

  // 3. Enforce actual UTF-8 byte limit on body stream (blocks chunked-transfer bypass without Content-Length)
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return c.json({ ok: false, error: 'Payload Too Large' }, 413);
  }

  c.set('rawWebhookBody', rawBody);
  await next();
}
