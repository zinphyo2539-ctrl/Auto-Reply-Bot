import {
  ExternalServiceError,
  PermanentProcessingError,
  RateLimitError,
} from '../lib/errors';

export interface TelegramApiSuccessResult {
  messageId: number | null;
  rawResult: unknown;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number; [key: string]: unknown } | boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export const telegramService = {
  async callApi(
    botToken: string,
    method: 'sendMessage' | 'sendPhoto' | 'editMessageText' | 'answerCallbackQuery',
    payload: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<TelegramApiSuccessResult> {
    if (!botToken || botToken.trim().length < 10) {
      throw new PermanentProcessingError('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
    }

    const url = `https://api.telegram.org/bot${botToken}/${method}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errName === 'TimeoutError' ||
        errName === 'AbortError' ||
        /timeout|aborted/i.test(errMsg);

      throw new ExternalServiceError(`Telegram network error on ${method}: ${errMsg}`, {
        retryable: !isTimeout,
        isUncertainDelivery: isTimeout && method !== 'editMessageText' && method !== 'answerCallbackQuery',
        code: isTimeout ? 'TELEGRAM_POST_SEND_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR',
      });
    }

    let body: TelegramApiResponse;
    try {
      body = (await response.json()) as TelegramApiResponse;
    } catch {
      if (response.status >= 500) {
        throw new ExternalServiceError(`Telegram HTTP ${response.status} non-JSON response`, {
          retryable: true,
          isUncertainDelivery: false,
        });
      }
      throw new PermanentProcessingError(`Telegram HTTP ${response.status} invalid JSON response`);
    }

    if (response.ok && body.ok) {
      const msgId =
        typeof body.result === 'object' && body.result !== null && typeof body.result.message_id === 'number'
          ? body.result.message_id
          : null;
      return { messageId: msgId, rawResult: body.result };
    }

    const status = response.status;
    const desc = body.description ?? `HTTP_${status}`;

    // Idempotent no-op when editing a message that already has identical content
    if (status === 400 && method === 'editMessageText' && /message is not modified/i.test(desc)) {
      return { messageId: null, rawResult: true };
    }

    if (status === 429) {
      const retryAfter = body.parameters?.retry_after ?? 15;
      throw new RateLimitError(`Telegram rate limit: ${desc}`, retryAfter);
    }

    if (status >= 500) {
      throw new ExternalServiceError(`Telegram server error (${status}): ${desc}`, {
        retryable: true,
        isUncertainDelivery: false,
      });
    }

    throw new PermanentProcessingError(`Telegram permanent error (${status}): ${desc}`);
  },

  async answerCallbackBestEffort(
    botToken: string,
    callbackQueryId: string,
    text?: string,
    showAlert = false
  ): Promise<void> {
    try {
      await this.callApi(
        botToken,
        'answerCallbackQuery',
        {
          callback_query_id: callbackQueryId,
          text: text ? text.slice(0, 195) : undefined,
          show_alert: showAlert,
        },
        3500
      );
    } catch {
      // Best-effort UI toast; never fail the authoritative transaction if callback toast times out
    }
  },
};
