import { Context, Next } from 'hono';
import { Env } from '../types/bindings';
import { constantTimeSecretMatch } from '../lib/crypto';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024; // 256 KB

export async function verifyTelegramWebhookMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isNaN(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ ok: false, error: 'Payload Too Large' }, 413);
    }
  }

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

  await next();
}
