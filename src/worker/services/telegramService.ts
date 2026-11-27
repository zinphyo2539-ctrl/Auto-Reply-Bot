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

export type TelegramApiMethod =
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendDocument'
  | 'editMessageText'
  | 'answerCallbackQuery'
  | 'getMe'
  | 'getChatMember';

const PLACEHOLDER_CREDENTIAL_OR_ID_REGEX =
  /^(?:CONFIGURED_IN_CLOUDFLARE_ENV|PENDING_OWNER_[A-Z0-9_]*|PLACEHOLDER[A-Z0-9_]*|CHANGE_ME[A-Z0-9_]*|REPLACE_ME[A-Z0-9_]*|YOUR_[A-Z0-9_]*|TODO[A-Z0-9_]*|EXAMPLE[A-Z0-9_]*|<[^>]+>)$/i;

export function isPlaceholderTelegramValue(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return true;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return true;
  }
  return PLACEHOLDER_CREDENTIAL_OR_ID_REGEX.test(trimmed);
}

export function isValidTelegramChatId(chatId: unknown): boolean {
  if (typeof chatId !== 'string' && typeof chatId !== 'number') {
    return false;
  }
  const trimmed = String(chatId).trim();
  if (!trimmed || trimmed === 'UNCONFIGURED_ADMIN_GROUP_CHAT') {
    return false;
  }
  if (PLACEHOLDER_CREDENTIAL_OR_ID_REGEX.test(trimmed)) {
    return false;
  }
  return true;
}

function isValidPositiveIntegerId(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) && Number(trimmed) > 0;
  }
  return false;
}

function validateTelegramMethodPayload(
  method: TelegramApiMethod,
  payload: Record<string, unknown>
): void {
  switch (method) {
    case 'sendMessage': {
      if (!isValidTelegramChatId(payload.chat_id)) {
        throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
      }
      if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
        throw new PermanentProcessingError('TELEGRAM_MESSAGE_TEXT_REQUIRED');
      }
      return;
    }
    case 'sendPhoto': {
      if (!isValidTelegramChatId(payload.chat_id)) {
        throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
      }
      if (
        typeof payload.photo !== 'string' ||
        payload.photo.trim().length === 0 ||
        isPlaceholderTelegramValue(payload.photo)
      ) {
        throw new PermanentProcessingError('TELEGRAM_PHOTO_REQUIRED');
      }
      return;
    }
    case 'sendDocument': {
      if (!isValidTelegramChatId(payload.chat_id)) {
        throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
      }
      if (
        typeof payload.document !== 'string' ||
        payload.document.trim().length === 0 ||
        isPlaceholderTelegramValue(payload.document)
      ) {
        throw new PermanentProcessingError('TELEGRAM_DOCUMENT_REQUIRED');
      }
      return;
    }
    case 'editMessageText': {
      if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
        throw new PermanentProcessingError('TELEGRAM_MESSAGE_TEXT_REQUIRED');
      }
      const hasInlineMessageId =
        payload.inline_message_id !== undefined &&
        payload.inline_message_id !== null &&
        String(payload.inline_message_id).trim().length > 0;

      if (hasInlineMessageId) {
        if (isPlaceholderTelegramValue(payload.inline_message_id)) {
          throw new PermanentProcessingError('TELEGRAM_INLINE_MESSAGE_ID_INVALID');
        }
        if (
          payload.chat_id !== undefined &&
          payload.chat_id !== null &&
          String(payload.chat_id).trim().length > 0 &&
          !isValidTelegramChatId(payload.chat_id)
        ) {
          throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
        }
        return;
      }

      if (!isValidTelegramChatId(payload.chat_id)) {
        throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
      }
      if (!isValidPositiveIntegerId(payload.message_id)) {
        throw new PermanentProcessingError('TELEGRAM_MESSAGE_ID_REQUIRED');
      }
      return;
    }
    case 'answerCallbackQuery': {
      if (
        typeof payload.callback_query_id !== 'string' ||
        payload.callback_query_id.trim().length === 0 ||
        isPlaceholderTelegramValue(payload.callback_query_id)
      ) {
        throw new PermanentProcessingError('TELEGRAM_CALLBACK_QUERY_ID_REQUIRED');
      }
      return;
    }
    case 'getMe': {
      return;
    }
    case 'getChatMember': {
      if (!isValidTelegramChatId(payload.chat_id)) {
        throw new PermanentProcessingError('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
      }
      if (!isValidPositiveIntegerId(payload.user_id)) {
        throw new PermanentProcessingError('TELEGRAM_USER_ID_REQUIRED');
      }
      return;
    }
  }
}

export const telegramService = {
  async callApi(
    botToken: string,
    method: TelegramApiMethod,
    payload: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<TelegramApiSuccessResult> {
    if (
      !botToken ||
      botToken.trim().length < 10 ||
      isPlaceholderTelegramValue(botToken)
    ) {
      throw new PermanentProcessingError('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
    }

    validateTelegramMethodPayload(method, payload);

    const isIdempotentMethod =
      method === 'editMessageText' ||
      method === 'answerCallbackQuery' ||
      method === 'getMe' ||
      method === 'getChatMember';
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

      // F-06A: Non-idempotent sendMessage/sendPhoto transport exceptions have uncertain delivery outcome
      // and must NEVER be blindly auto-retried.
      if (!isIdempotentMethod) {
        throw new ExternalServiceError(`Telegram transport failure on ${method}: ${errMsg}`, {
          retryable: false,
          isUncertainDelivery: true,
          code: isTimeout ? 'TELEGRAM_POST_SEND_TIMEOUT' : 'TELEGRAM_UNCERTAIN_TRANSPORT_ERROR',
        });
      }

      throw new ExternalServiceError(`Telegram network error on ${method}: ${errMsg}`, {
        retryable: true,
        isUncertainDelivery: false,
        code: isTimeout ? 'TELEGRAM_IDEMPOTENT_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR',
      });
    }

    let body: TelegramApiResponse;
    try {
      body = (await response.json()) as TelegramApiResponse;
    } catch {
      if (!isIdempotentMethod && (response.status === 200 || response.status === 502 || response.status === 504)) {
        throw new ExternalServiceError(`Telegram HTTP ${response.status} non-JSON response on ${method}`, {
          retryable: false,
          isUncertainDelivery: true,
          code: 'TELEGRAM_UNCERTAIN_RESPONSE_BODY',
        });
      }
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
