import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { SqliteD1Adapter } from '../src/worker/testing/sqliteD1Adapter';
import type { Env, OutboxQueuePayload, QueueProducer } from './testHelpers';
import type { MessageBatch } from '../src/worker/types/bindings';
import { customerService } from '../src/worker/services/customerService';
import { outboxConsumer } from '../src/worker/queues/outboxConsumer';
import { scheduledDispatcher } from '../src/worker/scheduled/dispatcher';
import { outboxRepository } from '../src/worker/repositories/outboxRepository';
import { messageRepository } from '../src/worker/repositories/messageRepository';
import { auditRepository } from '../src/worker/repositories/auditRepository';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const TEST_AES_KEY_V1 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestEnv(db: SqliteD1Adapter): {
  env: Env;
  enqueuedPayloads: OutboxQueuePayload[];
} {
  const enqueuedPayloads: OutboxQueuePayload[] = [];
  const queueProducer: QueueProducer<OutboxQueuePayload> = {
    async send(body) {
      enqueuedPayloads.push(body);
    },
    async sendBatch(messages) {
      for (const m of messages) {
        enqueuedPayloads.push(m.body);
      }
    },
  };

  const env: Env = {
    DB: db,
    OUTBOX_QUEUE: queueProducer,
    ENVIRONMENT: 'staging',
    TELEGRAM_BOT_USERNAME: 'vip_gaming_support_bot',
    TELEGRAM_ADMIN_GROUP_ID: '-100999888777',
    SUPER_ADMIN_IDS: '9001',
    OFFICIAL_CHANNEL_URL: 'https://t.me/slotmyanmar77777',
    GEMINI_MODEL: 'gemini-2.5-flash',
    APP_TIMEZONE: 'Asia/Yangon',
    RETENTION_MESSAGES_DAYS: '180',
    RETENTION_FINGERPRINTS_DAYS: '365',
    RETENTION_AUDIT_DAYS: '365',
    RETENTION_WITHDRAWAL_PII_DAYS: '30',
    RETENTION_OUTBOX_DAYS: '30',
    ENCRYPTION_KEY_VERSION: '1',
    TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_NOT_REAL_XYZ',
    TELEGRAM_WEBHOOK_SECRET: 'super_secret_webhook_token_v2',
    TELEGRAM_WEBHOOK_SECRET_PREVIOUS: 'super_secret_webhook_token_v1',
    GEMINI_API_KEY: 'TEST_GEMINI_API_KEY_NOT_REAL_123456',
    WITHDRAWAL_PII_ENCRYPTION_KEY: TEST_AES_KEY_V1,
    WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS: undefined,
  };

  return { env, enqueuedPayloads };
}

async function seedOutboxWithMessage(
  db: SqliteD1Adapter,
  env: Env,
  params: {
    outboxId: string;
    messageId: string;
    telegramMethod: 'sendMessage' | 'editMessageText';
    nowMs: number;
  }
): Promise<void> {
  await customerService.ensureActiveCustomer(env, {
    customerId: '8101',
    username: 'race_user',
    firstName: 'RaceUser',
  });

  await messageRepository
    .prepareInsertMessage(db, {
      messageId: params.messageId,
      customerId: '8101',
      direction: 'OUTBOUND',
      senderRole: 'SYSTEM',
      senderId: 'BOT',
      messageType: 'TEXT',
      textContent: 'Status update',
      isPotentialSlip: false,
      deliveryStatus: 'PENDING',
      createdAt: params.nowMs,
    })
    .run();

  await outboxRepository
    .prepareEnqueue(db, {
      outboxId: params.outboxId,
      idempotencyKey: `idem:${params.outboxId}`,
      eventType: 'CUSTOMER_NOTIFICATION',
      aggregateType: 'SYSTEM',
      aggregateId: params.outboxId,
      targetChatId: '8101',
      telegramMethod: params.telegramMethod,
      payload:
        params.telegramMethod === 'editMessageText'
          ? { chat_id: '8101', message_id: 100, text: 'Updated card' }
          : { chat_id: '8101', text: 'Your request has been reviewed.' },
      relatedMessageId: params.messageId,
      availableAt: params.nowMs,
      nowMs: params.nowMs,
    })
    .run();
}

describe('F-06 Remediation — Outbox Lease Expiry, Stale-Worker Fencing & Deterministic Concurrency', () => {
  let db: SqliteD1Adapter;
  let env: Env;
  let enqueuedPayloads: OutboxQueuePayload[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    db = new SqliteD1Adapter(':memory:');
    db.applyMigrations(MIGRATIONS_DIR);
    const created = createTestEnv(db);
    env = created.env;
    enqueuedPayloads = created.enqueuedPayloads;
    originalFetch = globalThis.fetch;

    await db
      .prepare(
        `INSERT INTO admins (
           telegram_user_id, role, is_active, has_started_bot, permissions_json,
           display_name, version, created_at, updated_at
         ) VALUES ('9001', 'SUPER_ADMIN', 1, 1, '["ticket.view"]', 'Super Admin', 1, 1750000000000, 1750000000000)`
      )
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it('F06-1. Exact 8-step concurrency race: expired SENDING is fenced to DELIVERY_UNCERTAIN on Worker B reclaim with ZERO duplicate Telegram send, and stale Worker A late 200 OK cannot overwrite state', async () => {
    let virtualNow = 1_750_000_000_000;
    const clock = () => virtualNow;

    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_race_send',
      messageId: 'msg_race_send',
      telegramMethod: 'sendMessage',
      nowMs: virtualNow,
    });

    const workerAEnteredFetch = createDeferred<void>();
    const releaseWorkerAFetch = createDeferred<Response>();
    let telegramCallCount = 0;

    globalThis.fetch = (async () => {
      telegramCallCount++;
      if (telegramCallCount === 1) {
        workerAEnteredFetch.resolve();
        return releaseWorkerAFetch.promise;
      }
      throw new Error('UNEXPECTED_DUPLICATE_TELEGRAM_CALL');
    }) as typeof globalThis.fetch;

    // Steps 1-2: Worker A claims obx_race_send, enters SENDING, and pauses inside mocked Telegram sendMessage
    const workerAPromise = outboxConsumer.processSingleOutbox(
      env,
      'obx_race_send',
      'cor_worker_a',
      'qev_race_1',
      undefined,
      clock
    );
    await workerAEnteredFetch.promise;

    const midRow = await outboxRepository.getById(db, 'obx_race_send');
    expect(midRow!.status).toBe('SENDING');
    expect(midRow!.lease_token).not.toBeNull();
    expect(telegramCallCount).toBe(1);

    // Step 3: Advance virtual clock past BOTH SENDING lease (25s) and queue-event stale threshold (45s)
    virtualNow += 50_000;

    // Steps 4-5: Worker B arrives with the same redelivered queue event and reclaims it
    const workerBResult = await outboxConsumer.processSingleOutbox(
      env,
      'obx_race_send',
      'cor_worker_b',
      'qev_race_1',
      undefined,
      clock
    );

    // Worker B MUST fence expired non-idempotent SENDING -> DELIVERY_UNCERTAIN without a second Telegram call
    expect(workerBResult.outcome).toBe('DELIVERY_UNCERTAIN');
    expect(telegramCallCount).toBe(1);

    const afterWorkerB = await outboxRepository.getById(db, 'obx_race_send');
    expect(afterWorkerB!.status).toBe('DELIVERY_UNCERTAIN');
    expect(afterWorkerB!.lease_token).toBeNull();

    const msgAfterB = await db
      .prepare(`SELECT delivery_status, telegram_message_id FROM messages WHERE message_id = 'msg_race_send'`)
      .first<{ delivery_status: string; telegram_message_id: number | null }>();
    expect(msgAfterB!.delivery_status).toBe('DELIVERY_UNCERTAIN');
    expect(msgAfterB!.telegram_message_id).toBeNull();

    const qevAfterB = await db
      .prepare(`SELECT consumer_lease_token, outcome FROM processed_queue_events WHERE event_id = 'qev_race_1'`)
      .first<{ consumer_lease_token: string; outcome: string }>();
    expect(qevAfterB!.outcome).toBe('ABORTED');
    const workerBLeaseToken = qevAfterB!.consumer_lease_token;

    // Steps 6-8: Delayed Telegram mock now returns HTTP 200 OK to stale Worker A
    releaseWorkerAFetch.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 777888 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const workerAResult = await workerAPromise;
    expect(workerAResult.outcome).toBe('SKIPPED');
    expect(telegramCallCount).toBe(1);

    // Outbox and message state MUST remain DELIVERY_UNCERTAIN (never overwritten by stale Worker A)
    const finalOutbox = await outboxRepository.getById(db, 'obx_race_send');
    expect(finalOutbox!.status).toBe('DELIVERY_UNCERTAIN');
    expect(finalOutbox!.telegram_message_id).toBeNull();

    const finalMsg = await db
      .prepare(`SELECT delivery_status, telegram_message_id FROM messages WHERE message_id = 'msg_race_send'`)
      .first<{ delivery_status: string; telegram_message_id: number | null }>();
    expect(finalMsg!.delivery_status).toBe('DELIVERY_UNCERTAIN');
    expect(finalMsg!.telegram_message_id).toBeNull();

    // Zero duplicate outbox rows created
    const outboxCount = await db.prepare('SELECT COUNT(*) AS c FROM outbox').first<{ c: number }>();
    expect(outboxCount!.c).toBe(1);

    // Worker B's processed_queue_events row was untouched by stale Worker A
    const qevFinal = await db
      .prepare(`SELECT consumer_lease_token, outcome FROM processed_queue_events WHERE event_id = 'qev_race_1'`)
      .first<{ consumer_lease_token: string; outcome: string }>();
    expect(qevFinal!.consumer_lease_token).toBe(workerBLeaseToken);
    expect(qevFinal!.outcome).toBe('ABORTED');

    // Non-destructive reconciliation audit log captures late Telegram message_id for operators
    const lateAudit = await db
      .prepare(
        `SELECT action, result, after_state_json FROM audit_logs
         WHERE action = 'OUTBOX_LATE_TELEGRAM_SUCCESS_AFTER_LEASE_LOSS'
           AND resource_id = 'obx_race_send'`
      )
      .first<{ action: string; result: string; after_state_json: string }>();
    expect(lateAudit).not.toBeNull();
    expect(lateAudit!.result).toBe('CONFLICT');
    expect(JSON.parse(lateAudit!.after_state_json)).toMatchObject({
      telegramMessageId: 777888,
      currentOutboxStatus: 'DELIVERY_UNCERTAIN',
    });

    // Audit hash chain remains cryptographically valid
    const chain = await auditRepository.verifyChainIntegrity(db);
    expect(chain.valid).toBe(true);
  });

  it('F06-2. Standalone lease-expiry fencing rejects stale Worker A even BEFORE Worker B or Cron runs', async () => {
    let virtualNow = 1_750_000_000_000;
    const clock = () => virtualNow;

    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_solo_expire',
      messageId: 'msg_solo_expire',
      telegramMethod: 'sendMessage',
      nowMs: virtualNow,
    });

    const enteredFetch = createDeferred<void>();
    const releaseFetch = createDeferred<Response>();
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;
      enteredFetch.resolve();
      return releaseFetch.promise;
    }) as typeof globalThis.fetch;

    const workerAPromise = outboxConsumer.processSingleOutbox(
      env,
      'obx_solo_expire',
      'cor_solo',
      'qev_solo_1',
      undefined,
      clock
    );
    await enteredFetch.promise;

    // Advance virtual clock +30s (past 25s SENDING lease), WITHOUT running Worker B or Cron
    virtualNow += 30_000;
    releaseFetch.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 999111 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const resA = await workerAPromise;
    expect(resA.outcome).toBe('SKIPPED');
    expect(calls).toBe(1);

    // Stale Worker A could not mark SENT because lease_expires_at <= sentNow
    const afterA = await outboxRepository.getById(db, 'obx_solo_expire');
    expect(afterA!.status).toBe('SENDING');

    // Subsequent Cron safely transitions expired SENDING to DELIVERY_UNCERTAIN with zero extra sends
    const cronRes = await scheduledDispatcher.runLeaseRecoveryCron(env, virtualNow);
    expect(cronRes.expiredSendingMarkedUncertain).toBe(1);
    expect(cronRes.requeuedCount).toBe(0);
    expect(calls).toBe(1);

    const finalRow = await outboxRepository.getById(db, 'obx_solo_expire');
    expect(finalRow!.status).toBe('DELIVERY_UNCERTAIN');
  });

  it('F06-3. DELIVERY_UNCERTAIN is never auto-replayed by consumer, Cron, retention prune, or DLQ', async () => {
    const nowMs = 1_750_000_000_000;
    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_uncertain_safe',
      messageId: 'msg_uncertain_safe',
      telegramMethod: 'sendMessage',
      nowMs,
    });

    // Move row to DELIVERY_UNCERTAIN via expired SENDING lease
    await db
      .prepare(
        `UPDATE outbox
         SET status = 'DELIVERY_UNCERTAIN',
             delivery_uncertain_at = ?1,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?1
         WHERE outbox_id = 'obx_uncertain_safe'`
      )
      .bind(nowMs)
      .run();

    let telegramCalls = 0;
    globalThis.fetch = (async () => {
      telegramCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof globalThis.fetch;

    // 1. Fresh consumer attempt -> SKIPPED, 0 Telegram calls
    const cons = await outboxConsumer.processSingleOutbox(
      env,
      'obx_uncertain_safe',
      'cor_retry',
      'qev_fresh_retry',
      nowMs + 1000
    );
    expect(cons.outcome).toBe('SKIPPED');
    expect(telegramCalls).toBe(0);

    // 2. Lease recovery Cron -> does NOT requeue or alter status
    const cron = await scheduledDispatcher.runLeaseRecoveryCron(env, nowMs + 120_000);
    expect(cron.expiredClaimedRecovered).toBe(0);
    expect(cron.expiredSendingMarkedUncertain).toBe(0);
    expect(cron.requeuedCount).toBe(0);

    // 3. Retention Cron 60 days later -> preserves DELIVERY_UNCERTAIN row (never pruned)
    const retention = await scheduledDispatcher.runRetentionCron(env, nowMs + 60 * 86400000);
    expect(retention.expiredOutboxDeleted).toBe(0);
    const preserved = await outboxRepository.getById(db, 'obx_uncertain_safe');
    expect(preserved).not.toBeNull();
    expect(preserved!.status).toBe('DELIVERY_UNCERTAIN');

    // 4. DLQ consumer -> audits + alerts SUPER_ADMIN + acks, NEVER replays obx_uncertain_safe
    let acked = false;
    const dlqBatch: MessageBatch<OutboxQueuePayload> = {
      queue: 'vip-outbox-dlq-staging',
      ackAll: () => {},
      retryAll: () => {
        throw new Error('DLQ_MUST_NOT_RETRY');
      },
      messages: [
        {
          id: 'dlq_msg_1',
          timestamp: new Date(nowMs + 2000),
          attempts: 5,
          body: {
            eventId: 'qev_dlq_1',
            outboxId: 'obx_uncertain_safe',
            orderingKey: '8101',
            sequenceNo: 1,
            correlationId: 'cor_dlq_1',
          },
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error('DLQ_MUST_NOT_RETRY');
          },
        },
      ],
    };

    const dlqRes = await outboxConsumer.processDlqBatch(env, dlqBatch, nowMs + 2000);
    expect(dlqRes.processedCount).toBe(1);
    expect(acked).toBe(true);
    expect(telegramCalls).toBe(0);
    // Bounded DLQ_ALERT enqueued for SUPER_ADMIN (9001), NOT replay of obx_uncertain_safe
    expect(enqueuedPayloads.every((p) => p.outboxId !== 'obx_uncertain_safe')).toBe(true);

    const stillUncertain = await outboxRepository.getById(db, 'obx_uncertain_safe');
    expect(stillUncertain!.status).toBe('DELIVERY_UNCERTAIN');
  });

  it('F06-4. Idempotent editMessageText recovers safely on expired SENDING reclaim and fences out stale Worker A', async () => {
    let virtualNow = 1_750_000_000_000;
    const clock = () => virtualNow;

    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_idem_edit',
      messageId: 'msg_idem_edit',
      telegramMethod: 'editMessageText',
      nowMs: virtualNow,
    });

    const workerAEnteredFetch = createDeferred<void>();
    const releaseWorkerAFetch = createDeferred<Response>();
    let callNum = 0;

    globalThis.fetch = (async () => {
      callNum++;
      if (callNum === 1) {
        workerAEnteredFetch.resolve();
        return releaseWorkerAFetch.promise;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 555002 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const workerAPromise = outboxConsumer.processSingleOutbox(
      env,
      'obx_idem_edit',
      'cor_edit_a',
      'qev_edit_1',
      undefined,
      clock
    );
    await workerAEnteredFetch.promise;

    // Advance virtual clock past lease + queue stale threshold -> Worker B reclaims and delivers idempotently
    virtualNow += 50_000;
    const workerBResult = await outboxConsumer.processSingleOutbox(
      env,
      'obx_idem_edit',
      'cor_edit_b',
      'qev_edit_1',
      undefined,
      clock
    );
    expect(workerBResult.outcome).toBe('SENT');
    expect(callNum).toBe(2);

    // Now stale Worker A finishes with a conflicting 403 permanent error -> MUST be fenced out as SKIPPED
    releaseWorkerAFetch.resolve(
      new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const workerAResult = await workerAPromise;
    expect(workerAResult.outcome).toBe('SKIPPED');

    // Outbox, message, and processed_queue_events remain intact as Worker B's SENT / COMPLETED
    const finalRow = await outboxRepository.getById(db, 'obx_idem_edit');
    expect(finalRow!.status).toBe('SENT');
    expect(finalRow!.telegram_message_id).toBe(555002);

    const qev = await db
      .prepare(`SELECT outcome FROM processed_queue_events WHERE event_id = 'qev_edit_1'`)
      .first<{ outcome: string }>();
    expect(qev!.outcome).toBe('COMPLETED');
  });

  it('F06-5. Active unexpired SENDING blocks concurrent duplicate consumer; expired pre-network CLAIMED recovers cleanly', async () => {
    let virtualNow = 1_750_000_000_000;
    const clock = () => virtualNow;

    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_active_guard',
      messageId: 'msg_active_guard',
      telegramMethod: 'sendMessage',
      nowMs: virtualNow,
    });

    const enteredFetch = createDeferred<void>();
    const releaseFetch = createDeferred<Response>();
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;
      enteredFetch.resolve();
      return releaseFetch.promise;
    }) as typeof globalThis.fetch;

    const workerAPromise = outboxConsumer.processSingleOutbox(
      env,
      'obx_active_guard',
      'cor_act_a',
      'qev_act_1',
      undefined,
      clock
    );
    await enteredFetch.promise;

    // Only +5s elapsed (lease still active!) -> duplicate event (same ID and different ID) must SKIP
    virtualNow += 5_000;
    const dupSame = await outboxConsumer.processSingleOutbox(
      env,
      'obx_active_guard',
      'cor_act_dup1',
      'qev_act_1',
      undefined,
      clock
    );
    const dupOther = await outboxConsumer.processSingleOutbox(
      env,
      'obx_active_guard',
      'cor_act_dup2',
      'qev_act_2',
      undefined,
      clock
    );
    expect(dupSame.outcome).toBe('SKIPPED');
    expect(dupOther.outcome).toBe('SKIPPED');
    expect(calls).toBe(1);

    // Worker A completes within valid lease -> SENT
    releaseFetch.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 333444 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect((await workerAPromise).outcome).toBe('SENT');
    expect(calls).toBe(1);

    // Pre-network expired CLAIMED row recovers cleanly on consumer reclaim and sends once
    await seedOutboxWithMessage(db, env, {
      outboxId: 'obx_claimed_crash',
      messageId: 'msg_claimed_crash',
      telegramMethod: 'sendMessage',
      nowMs: virtualNow,
    });
    await db
      .prepare(
        `UPDATE outbox
         SET status = 'CLAIMED', lease_owner = 'crashed_worker', lease_token = 'tok_old',
             lease_expires_at = ?1, attempt_count = 1
         WHERE outbox_id = 'obx_claimed_crash'`
      )
      .bind(virtualNow - 1000)
      .run();

    let claimedCalls = 0;
    globalThis.fetch = (async () => {
      claimedCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 666777 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const recoveredRes = await outboxConsumer.processSingleOutbox(
      env,
      'obx_claimed_crash',
      'cor_rec',
      'qev_rec_1',
      undefined,
      clock
    );
    expect(recoveredRes.outcome).toBe('SENT');
    expect(claimedCalls).toBe(1);
  });
});
