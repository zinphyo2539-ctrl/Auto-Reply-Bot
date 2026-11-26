import { Hono } from 'hono';
import type { Env } from '../types/bindings';
import {
  verifyTelegramWebhookMiddleware,
  type WebhookContextVariables,
} from '../middleware/verifyTelegramWebhook';
import { TelegramUpdateSchema } from '../schemas/telegramSchemas';
import { updateRouter } from '../handlers/updateRouter';
import { logger } from '../lib/logger';
import { generatePrefixedId } from '../lib/ids';

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: WebhookContextVariables }>();

  app.get('/healthz', (c) => {
    const rawUsername = c.env?.TELEGRAM_BOT_USERNAME?.trim() || 'unconfigured';
    const normalizedUsername = rawUsername.replace(/^@/, '');
    return c.json({
      ok: true,
      service: 'vip-gaming-bot',
      brand: '7777club',
      environment: c.env?.ENVIRONMENT ?? 'unknown',
      bot_username: normalizedUsername,
      timezone: c.env?.APP_TIMEZONE ?? 'Asia/Yangon',
    });
  });

  app.post('/webhook', verifyTelegramWebhookMiddleware, async (c) => {
    let rawJson: unknown;
    try {
      const rawBody = c.get('rawWebhookBody');
      rawJson = JSON.parse(rawBody);
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
