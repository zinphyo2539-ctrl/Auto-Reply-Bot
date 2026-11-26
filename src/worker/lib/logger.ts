const SENSITIVE_KEY_PATTERN =
  /token|secret|password|pin|otp|api_key|apikey|authorization|ciphertext|destination_full|raw_destination|encryption_key/i;

const BOT_TOKEN_URL_PATTERN = /bot\d+:[A-Za-z0-9_-]{20,}/g;
const LONG_DIGIT_ACCOUNT_PATTERN = /\b\d{7,19}\b/g;

export function redactSensitiveString(input: string): string {
  return input
    .replace(BOT_TOKEN_URL_PATTERN, 'bot[REDACTED_TOKEN]')
    .replace(LONG_DIGIT_ACCOUNT_PATTERN, '[REDACTED_DIGITS]');
}

export function redactLogObject(obj: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[MAX_DEPTH]';
  }
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'string') {
    return redactSensitiveString(obj);
  }
  if (typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactLogObject(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      output[k] = '[REDACTED]';
    } else {
      output[k] = redactLogObject(v, depth + 1);
    }
  }
  return output;
}

export interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  event: string;
  correlationId: string;
  updateId?: number | null;
  ticketId?: string | null;
  outboxId?: string | null;
  customerId?: string | null;
  adminId?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
}

export const logger = {
  log(entry: LogEntry): string {
    const safeEntry = {
      timestamp: Date.now(),
      level: entry.level,
      event: entry.event,
      correlationId: entry.correlationId,
      updateId: entry.updateId ?? null,
      ticketId: entry.ticketId ?? null,
      outboxId: entry.outboxId ?? null,
      customerId: entry.customerId ?? null,
      adminId: entry.adminId ?? null,
      message: entry.message ? redactSensitiveString(entry.message) : undefined,
      metadata: entry.metadata ? (redactLogObject(entry.metadata) as Record<string, unknown>) : undefined,
    };
    const serialized = JSON.stringify(safeEntry);
    if (entry.level === 'ERROR' || entry.level === 'CRITICAL') {
      console.error(serialized);
    } else if (entry.level === 'WARN') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
    return serialized;
  },
};
