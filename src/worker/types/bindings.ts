export interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface OutboxQueuePayload {
  eventId: string;
  outboxId: string;
  orderingKey: string;
  sequenceNo: number;
  correlationId: string;
}

export interface QueueMessage<Body = OutboxQueuePayload> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<Body = OutboxQueuePayload> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface QueueProducer<Body = OutboxQueuePayload> {
  send(message: Body, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: Body; delaySeconds?: number }>): Promise<void>;
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}

export interface Env {
  DB: D1Database;
  OUTBOX_QUEUE: QueueProducer<OutboxQueuePayload>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET_PREVIOUS?: string;
  GEMINI_API_KEY: string;
  WITHDRAWAL_PII_ENCRYPTION_KEY: string;
  WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS?: string;
  ENCRYPTION_KEY_VERSION?: string;
  ENVIRONMENT: 'local' | 'staging' | 'production';
  TELEGRAM_BOT_USERNAME: string;
  TELEGRAM_ADMIN_GROUP_ID: string;
  SUPER_ADMIN_IDS: string;
  OFFICIAL_CHANNEL_URL: string;
  GEMINI_MODEL: string;
  APP_TIMEZONE: string;
  SUPPORT_REMINDER_MINUTES: string;
  SUPPORT_ESCALATION_MINUTES: string;
  RETENTION_MESSAGES_DAYS: string;
  RETENTION_FINGERPRINTS_DAYS: string;
  RETENTION_AUDIT_DAYS: string;
  RETENTION_WITHDRAWAL_PII_DAYS?: string;
}
