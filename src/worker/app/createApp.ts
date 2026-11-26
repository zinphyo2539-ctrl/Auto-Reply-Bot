import { Hono } from 'hono';
import type { Env } from '../types/bindings';
import { verifyTelegramWebhookMiddleware } from '../middleware/verifyTelegramWebhook';
import { TelegramUpdateSchema } from '../schemas/telegramSchemas';
import { updateRouter } from '../handlers/updateRouter';
import { logger } from '../lib/logger';
import { generatePrefixedId } from '../lib/ids';

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/healthz', (c) => {
    return c.json({
      ok: true,
      service: 'vip-gaming-bot',
      brand: '7777club',
      environment: c.env?.ENVIRONMENT ?? 'unknown',
    });
  });

  app.post('/webhook', verifyTelegramWebhookMiddleware, async (c) => {
    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'Malformed JSON body' }, 400);
    }

    const parsed = TelegramUpdateSchema.safeParse(rawJson);
    if (!parsed.success) {
      logger.log({
        level: 'WARN',
        event: 'INVALID_TELEGRAM_UPDATE_PAYLOAD',
        correlationId: generatePrefixedId('cor'),
        metadata: { issues: parsed.error.issues.map((i) => i.message) },
      });
      return c.json({ ok: false, error: 'Invalid Telegram Update schema' }, 400);
    }

    try {
      const result = await updateRouter.processUpdate(c.env, parsed.data);
      return c.json({
        ok: true,
        status: result.status,
        update_id: result.updateId,
      });
    } catch (err) {
      logger.log({
        level: 'ERROR',
        event: 'WEBHOOK_UNHANDLED_ERROR',
        correlationId: generatePrefixedId('cor'),
        updateId: parsed.data.update_id,
        message: err instanceof Error ? err.message : String(err),
      });
      return c.json({ ok: false, error: 'Internal processing error' }, 500);
    }
  });

  return app;
}
