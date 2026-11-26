import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { SqliteD1Adapter } from '../src/worker/testing/sqliteD1Adapter';
import type { Env, OutboxQueuePayload, QueueProducer } from './testHelpers';
import { createApp } from '../src/worker/app/createApp';
import { handoverService } from '../src/worker/services/handoverService';
import { slipService } from '../src/worker/services/slipService';
import { depositService } from '../src/worker/services/depositService';
import { withdrawalService } from '../src/worker/services/withdrawalService';
import { customerService } from '../src/worker/services/customerService';
import { adminService } from '../src/worker/services/adminService';
import { outboxConsumer } from '../src/worker/queues/outboxConsumer';
import { scheduledDispatcher } from '../src/worker/scheduled/dispatcher';
import { auditRepository } from '../src/worker/repositories/auditRepository';
import {
  encryptPayoutDestination,
  decryptPayoutDestination,
} from '../src/worker/lib/crypto';
import { encodeCallbackData, decodeCallbackData } from '../src/worker/lib/callbackCodec';
import { chunkTelegramText } from '../src/worker/lib/textChunker';
import { redactLogObject } from '../src/worker/lib/logger';
import { containsForbiddenFinancialCommitment } from '../src/worker/schemas/geminiSchemas';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

const TEST_AES_KEY_V1 = 'test_aes_key_material_v1_32bytes_strong_secret_key';
const TEST_AES_KEY_V2 = 'test_aes_key_material_v2_32bytes_rotated_secret_key';

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
    SUPPORT_REMINDER_MINUTES: '30',
    SUPPORT_ESCALATION_MINUTES: '60',
    RETENTION_MESSAGES_DAYS: '90',
    RETENTION_FINGERPRINTS_DAYS: '180',
    RETENTION_AUDIT_DAYS: '365',
    RETENTION_WITHDRAWAL_PII_DAYS: '30',
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

describe('7777club VIP Gaming Telegram AI Support System — Full Verification Suite (20 Categories)', () => {
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

    const nowMs = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO admins (
             telegram_user_id, role, is_active, has_started_bot, permissions_json,
             display_name, version, created_at, updated_at
           ) VALUES (?1, 'SUPER_ADMIN', 1, 1, ?2, 'Super Admin', 1, ?3, ?3)`
        )
        .bind(
          '9001',
          JSON.stringify(['ticket.view', 'ticket.claim', 'ticket.reply', 'ticket.resolve', 'slip.review', 'deposit.review', 'withdrawal.review', 'config.manage']),
          nowMs
        ),
      db
        .prepare(
          `INSERT INTO admins (
             telegram_user_id, role, is_active, has_started_bot, permissions_json,
             display_name, version, created_at, updated_at
           ) VALUES (?1, 'SUPPORT_AGENT', 1, 1, ?2, 'Agent Alpha', 1, ?3, ?3)`
        )
        .bind('9002', JSON.stringify(['ticket.view', 'ticket.claim', 'ticket.reply', 'ticket.resolve', 'slip.review']), nowMs),
      db
        .prepare(
          `INSERT INTO admins (
             telegram_user_id, role, is_active, has_started_bot, permissions_json,
             display_name, version, created_at, updated_at
           ) VALUES (?1, 'SUPPORT_AGENT', 1, 1, ?2, 'Agent Beta', 1, ?3, ?3)`
        )
        .bind('9003', JSON.stringify(['ticket.view', 'ticket.claim', 'ticket.reply', 'ticket.resolve', 'slip.review']), nowMs),
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    db.close();
  });

  // 1. Migrations & Schema Integrity
  it('1. Applies all D1 migrations cleanly with 17 tables, seed config, and FAQs', async () => {
    const tablesRes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>();
    const tableNames = tablesRes.results.map((r) => r.name);

    const expectedTables = [
      'customers',
      'admins',
      'support_tickets',
      'messages',
      'slip_fingerprints',
      'slip_reviews',
      'deposit_requests',
      'withdrawal_requests',
      'customer_sessions',
      'outbox',
      'processed_updates',
      'processed_queue_events',
      'admin_sessions',
      'faq_entries',
      'config',
      'config_versions',
      'audit_logs',
    ];
    for (const t of expectedTables) {
      expect(tableNames).toContain(t);
    }

    const activeCfg = await db
      .prepare(`SELECT menu_buttons_json, ai_enabled FROM config WHERE config_id = 'active'`)
      .first<{ menu_buttons_json: string; ai_enabled: number }>();
    expect(activeCfg).not.toBeNull();
    expect(activeCfg!.menu_buttons_json).toContain('WITHDRAW');
    expect(activeCfg!.menu_buttons_json).toContain('DEPOSIT');
  });

  // 2. SQL Constraints, Immutability Triggers & Audit Hash Chain
  it('2. Enforces audit_logs immutability triggers, hash-chain integrity, and single active ticket partial unique index', async () => {
    const nowMs = Date.now();
    await auditRepository.appendImmediate(db, {
      actorId: 'SYSTEM',
      actorRole: 'SYSTEM',
      action: 'CHAIN_CHECK_1',
      resourceType: 'SYSTEM',
      resourceId: 'SYS',
      result: 'SUCCESS',
      correlationId: 'cor_1',
      nowMs,
    });
    await auditRepository.appendImmediate(db, {
      actorId: 'SYSTEM',
      actorRole: 'SYSTEM',
      action: 'CHAIN_CHECK_2',
      resourceType: 'SYSTEM',
      resourceId: 'SYS',
      result: 'SUCCESS',
      correlationId: 'cor_2',
      nowMs: nowMs + 1,
    });

    const chain = await auditRepository.verifyChainIntegrity(db);
    expect(chain.valid).toBe(true);
    expect(chain.checkedCount).toBe(2);

    // UPDATE forbidden by SQLite trigger
    await expect(db.prepare(`UPDATE audit_logs SET action = 'TAMPERED'`).run()).rejects.toThrow(
      /AUDIT_LOGS_IMMUTABLE/i
    );

    // Recent DELETE forbidden by SQLite trigger
    await expect(db.prepare(`DELETE FROM audit_logs`).run()).rejects.toThrow(
      /AUDIT_LOGS_IMMUTABLE/i
    );

    // Partial unique index prevents 2 active tickets for the same customer
    await customerService.ensureActiveCustomer(env, {
      customerId: '5001',
      username: 'aung',
      firstName: 'Aung',
    });

    await db
      .prepare(
        `INSERT INTO support_tickets (ticket_id, customer_id, ticket_type, status, version, created_at, updated_at)
         VALUES ('tkt_1', '5001', 'GENERAL_SUPPORT', 'OPEN', 1, ?1, ?1)`
      )
      .bind(nowMs)
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO support_tickets (ticket_id, customer_id, ticket_type, status, assigned_admin_id, version, created_at, updated_at)
           VALUES ('tkt_2', '5001', 'GENERAL_SUPPORT', 'ASSIGNED', '9002', 1, ?1, ?1)`
        )
        .bind(nowMs)
        .run()
    ).rejects.toThrow();
  });

  // 3. Webhook Auth, Rotation & 256KB Payload Limit
  it('3. Enforces webhook secret token validation, rotation support, and 256KB body limit', async () => {
    const app = createApp();

    const resMissing = await app.fetch(
      new Request('https://bot.example/webhook', { method: 'POST', body: '{}' }),
      env
    );
    expect(resMissing.status).toBe(401);

    const resWrong = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'invalid_secret' },
        body: '{}',
      }),
      env
    );
    expect(resWrong.status).toBe(401);

    const resOversize = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          'Content-Length': String(300 * 1024),
        },
        body: '{}',
      }),
      env
    );
    expect(resOversize.status).toBe(413);

    // Valid previous rotation secret succeeds
    const resPrev = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS!,
        },
        body: JSON.stringify({
          update_id: 10001,
          message: {
            message_id: 1,
            date: 1700000000,
            chat: { id: 7001, type: 'private' },
            from: { id: 7001, is_bot: false, first_name: 'Mya' },
            text: '/start',
          },
        }),
      }),
      env
    );
    expect(resPrev.status).toBe(200);
    const body = (await resPrev.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('PROCESSED');
  });

  // 4. Webhook Idempotency & Deduplication
  it('4. Deduplicates repeated webhook deliveries with identical update_id', async () => {
    const app = createApp();
    const payload = JSON.stringify({
      update_id: 20002,
      message: {
        message_id: 10,
        date: 1700000000,
        chat: { id: 7002, type: 'private' },
        from: { id: 7002, is_bot: false, first_name: 'Hla' },
        text: '/start',
      },
    });

    const res1 = (await (
      await app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: payload,
        }),
        env
      )
    ).json()) as { status: string };
    expect(res1.status).toBe('PROCESSED');

    const count1 = (await db.prepare('SELECT COUNT(*) as c FROM outbox').first<{ c: number }>())!.c;

    const res2 = (await (
      await app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: payload,
        }),
        env
      )
    ).json()) as { status: string };
    expect(res2.status).toBe('DUPLICATE_IGNORED');

    const count2 = (await db.prepare('SELECT COUNT(*) as c FROM outbox').first<{ c: number }>())!.c;
    expect(count2).toBe(count1);
  });

  // 5. Admin RBAC & Denied Action Auditing
  it('5. Blocks SUPPORT_AGENT from financial decisions and global AI toggle, and records denied attempts in audit_logs', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '5010',
      username: 'kyaw',
      firstName: 'Kyaw',
    });

    const { draftToken } = await depositService.startDepositWizard(env, '5010');
    await depositService.handleAmountInput(env, '5010', '25000');
    await depositService.handleMethodSelection(env, '5010', 'KBZPAY');
    await depositService.handleReferenceInput(env, '5010', 'TXN998877');
    const { deposit } = await depositService.confirmSubmission(env, {
      customerId: '5010',
      draftToken,
      correlationId: 'cor_rbac_dep',
    });

    // SUPPORT_AGENT (9002) cannot approve deposit
    await expect(
      depositService.submitSuperAdminDecision(env, {
        adminId: '9002',
        depositId: deposit.deposit_id,
        newStatus: 'APPROVED_MANUAL_CREDITED',
        adminEvidenceRef: 'FAKE_REF',
        expectedVersion: 1,
        correlationId: 'cor_rbac_1',
      })
    ).rejects.toThrow(/SUPER_ADMIN/i);

    // SUPPORT_AGENT (9002) cannot toggle global AI
    await expect(
      adminService.toggleGlobalAi(env, { adminId: '9002', correlationId: 'cor_rbac_2' })
    ).rejects.toThrow(/SUPER_ADMIN/i);

    const denied = await db
      .prepare(`SELECT action FROM audit_logs WHERE actor_id = '9002' AND result = 'DENIED'`)
      .all<{ action: string }>();
    const actions = denied.results.map((r) => r.action);
    expect(actions).toContain('UNAUTHORIZED_DEPOSIT_DECISION_ATTEMPT');
    expect(actions).toContain('UNAUTHORIZED_CONFIG_TOGGLE_AI_ATTEMPT');
  });

  // 6. Concurrent Ticket Takeover Race Safety
  it('6. Ensures only one administrator wins concurrent ticket takeover on version 1', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '5020',
      username: 'su',
      firstName: 'Su',
    });

    const { ticket } = await handoverService.escalateCustomerToHuman(env, {
      customerId: '5020',
      customerFirstName: 'Su',
      customerUsername: 'su',
      ticketType: 'GENERAL_SUPPORT',
      summaryText: 'Need human support',
      reason: 'Customer requested human',
      correlationId: 'cor_race_init',
    });

    const [r1, r2] = await Promise.allSettled([
      handoverService.takeOverTicket(env, {
        adminId: '9002',
        ticketId: ticket.ticket_id,
        expectedVersion: 1,
        correlationId: 'cor_race_a',
      }),
      handoverService.takeOverTicket(env, {
        adminId: '9003',
        ticketId: ticket.ticket_id,
        expectedVersion: 1,
        correlationId: 'cor_race_b',
      }),
    ]);

    expect([r1, r2].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([r1, r2].filter((r) => r.status === 'rejected')).toHaveLength(1);

    const finalTicket = await db
      .prepare('SELECT assigned_admin_id, status, version FROM support_tickets WHERE ticket_id = ?1')
      .bind(ticket.ticket_id)
      .first<{ assigned_admin_id: string; status: string; version: number }>();

    expect(finalTicket!.status).toBe('ASSIGNED');
    expect(finalTicket!.version).toBe(2);
    expect(['9002', '9003']).toContain(finalTicket!.assigned_admin_id);
  });

  // 7. Release Preserves HUMAN Mode vs Explicit Resolve & Return to AI
  it('7. Keeps customer in HUMAN mode on Release and returns to AI only on explicit Resolve & Return to AI', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '5021',
      username: 'lin',
      firstName: 'Lin',
    });

    const { ticket } = await handoverService.escalateCustomerToHuman(env, {
      customerId: '5021',
      customerFirstName: 'Lin',
      customerUsername: 'lin',
      ticketType: 'GENERAL_SUPPORT',
      summaryText: 'Support needed',
      reason: 'Escalation',
      correlationId: 'cor_rel_0',
    });

    await handoverService.takeOverTicket(env, {
      adminId: '9002',
      ticketId: ticket.ticket_id,
      expectedVersion: 1,
      correlationId: 'cor_rel_1',
    });

    await handoverService.releaseTicket(env, {
      adminId: '9002',
      ticketId: ticket.ticket_id,
      correlationId: 'cor_rel_2',
    });

    const custAfterRelease = await db
      .prepare('SELECT chat_mode FROM customers WHERE telegram_user_id = ?1')
      .bind('5021')
      .first<{ chat_mode: string }>();
    expect(custAfterRelease!.chat_mode).toBe('HUMAN');

    // Claim again and explicitly Resolve & Return to AI
    await handoverService.takeOverTicket(env, {
      adminId: '9003',
      ticketId: ticket.ticket_id,
      expectedVersion: 3,
      correlationId: 'cor_rel_3',
    });

    const res = await handoverService.resolveTicket(env, {
      adminId: '9003',
      ticketId: ticket.ticket_id,
      returnToAi: true,
      correlationId: 'cor_rel_4',
    });
    expect(res.chatMode).toBe('AI');

    const custAfterResolve = await db
      .prepare('SELECT chat_mode FROM customers WHERE telegram_user_id = ?1')
      .bind('5021')
      .first<{ chat_mode: string }>();
    expect(custAfterResolve!.chat_mode).toBe('AI');
  });

  // 8. AI 15-Message Strict Customer Isolation
  it('8. Strictly isolates AI conversation context per customer_id with <=15 recent messages', async () => {
    // Enable AI in config
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();

    await customerService.ensureActiveCustomer(env, {
      customerId: '6001',
      username: 'custa',
      firstName: 'CustA',
    });
    const custB = await customerService.ensureActiveCustomer(env, {
      customerId: '6002',
      username: 'custb',
      firstName: 'CustB',
    });

    const baseTime = Date.now() - 60000;
    // Secret message from Customer A
    await db
      .prepare(
        `INSERT INTO messages (message_id, customer_id, direction, sender_role, sender_id, message_type, text_content, is_potential_slip, include_in_ai_context, delivery_status, created_at)
         VALUES ('msg_a_secret', '6001', 'INBOUND', 'USER', '6001', 'TEXT', 'TOP_SECRET_CUST_A_TOKEN_XYZ', 0, 1, 'RECEIVED', ?1)`
      )
      .bind(baseTime)
      .run();

    // 20 historical messages for Customer B
    for (let i = 1; i <= 20; i++) {
      await db
        .prepare(
          `INSERT INTO messages (message_id, customer_id, direction, sender_role, sender_id, message_type, text_content, is_potential_slip, include_in_ai_context, delivery_status, created_at)
           VALUES (?1, '6002', 'INBOUND', 'USER', '6002', 'TEXT', ?2, 0, 1, 'RECEIVED', ?3)`
        )
        .bind(`msg_b_${i}`, `CustB historic msg ${i}`, baseTime + i * 100)
        .run();
    }

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      replyText: 'Hello! Here are our 7777club FAQ details.',
                      requiresHumanHandover: false,
                      ticketCategory: 'NONE',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    await customerService.handleCustomerText(env, {
      customer: custB,
      telegramMessageId: 777,
      updateId: 888,
      text: 'Tell me about games',
      correlationId: 'cor_iso_1',
    });

    expect(capturedBody).not.toContain('TOP_SECRET_CUST_A_TOKEN_XYZ');
    expect(capturedBody).toContain('CustB historic msg 20');
    expect(capturedBody).not.toContain('CustB historic msg 1"');
  });

  // 9. AI Zero Financial Authority Guardrail
  it('9. Blocks forbidden financial approval claims from Gemini and triggers human handover', async () => {
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();

    expect(containsForbiddenFinancialCommitment('Your deposit has been approved!')).toBe(true);
    expect(containsForbiddenFinancialCommitment('ငွေသွင်းအတည်ပြုပြီးပါပြီ')).toBe(true);
    expect(containsForbiddenFinancialCommitment('Please use the Deposit button in /start.')).toBe(false);

    const cust = await customerService.ensureActiveCustomer(env, {
      customerId: '6003',
      username: 'guard',
      firstName: 'GuardUser',
    });

    // Simulate rogue Gemini output claiming withdrawal is paid
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      replyText: 'Your withdrawal has been paid and balance updated!',
                      requiresHumanHandover: false,
                      ticketCategory: 'NONE',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof globalThis.fetch;

    await customerService.handleCustomerText(env, {
      customer: cust,
      telegramMessageId: 501,
      updateId: 502,
      text: 'Approve my withdrawal now',
      correlationId: 'cor_guard_1',
    });

    const updated = await db
      .prepare('SELECT chat_mode FROM customers WHERE telegram_user_id = ?1')
      .bind('6003')
      .first<{ chat_mode: string }>();
    expect(updated!.chat_mode).toBe('HUMAN');

    const aiMsgs = await db
      .prepare(`SELECT * FROM messages WHERE customer_id = '6003' AND sender_role = 'MODEL'`)
      .all();
    expect(aiMsgs.results).toHaveLength(0);
  });

  // 10 & 11. Manual Deposit Lifecycle (Wizard, Evidence Ref, Idempotency, Concurrency)
  it('10 & 11. Completes manual deposit wizard, enforces admin_operation_evidence_ref, and prevents double approval', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '6100',
      username: 'depu',
      firstName: 'DepUser',
    });

    const { draftToken } = await depositService.startDepositWizard(env, '6100');
    await depositService.handleAmountInput(env, '6100', '50000');
    await depositService.handleMethodSelection(env, '6100', 'WAVEPAY');
    await depositService.handleReferenceInput(env, '6100', 'WAVE-TXN-889900');

    const sub1 = await depositService.confirmSubmission(env, {
      customerId: '6100',
      draftToken,
      correlationId: 'cor_dep_1',
    });
    expect(sub1.createdNew).toBe(true);
    expect(sub1.deposit.deposit_id).toMatch(/^DEP-\d{8}-[A-Z0-9]{10}$/);

    // Repeated confirm with same draftToken is idempotent
    const sub2 = await depositService.confirmSubmission(env, {
      customerId: '6100',
      draftToken,
      correlationId: 'cor_dep_2',
    });
    expect(sub2.createdNew).toBe(false);
    expect(sub2.deposit.deposit_id).toBe(sub1.deposit.deposit_id);

    // SUPER_ADMIN cannot approve without admin_operation_evidence_ref
    await expect(
      depositService.submitSuperAdminDecision(env, {
        adminId: '9001',
        depositId: sub1.deposit.deposit_id,
        newStatus: 'APPROVED_MANUAL_CREDITED',
        adminEvidenceRef: '',
        expectedVersion: 1,
        correlationId: 'cor_dep_3',
      })
    ).rejects.toThrow(/admin_operation_evidence_ref/i);

    // SUPER_ADMIN approves with evidence ref
    const approved = await depositService.submitSuperAdminDecision(env, {
      adminId: '9001',
      depositId: sub1.deposit.deposit_id,
      newStatus: 'APPROVED_MANUAL_CREDITED',
      adminEvidenceRef: 'PANEL-CREDIT-2026-0091',
      expectedVersion: 1,
      correlationId: 'cor_dep_4',
    });
    expect(approved.status).toBe('APPROVED_MANUAL_CREDITED');
    expect(approved.admin_operation_evidence_ref).toBe('PANEL-CREDIT-2026-0091');
    expect(approved.version).toBe(2);

    // Stale version or second decision rejected
    await expect(
      depositService.submitSuperAdminDecision(env, {
        adminId: '9001',
        depositId: sub1.deposit.deposit_id,
        newStatus: 'REJECTED',
        decisionNote: 'Late reject',
        expectedVersion: 1,
        correlationId: 'cor_dep_5',
      })
    ).rejects.toThrow(/concurrently|terminal/i);
  });

  // 12, 13, 14, 15. Manual Withdrawal Lifecycle, Anti-PIN/OTP, AES-256-GCM AAD, Key Rotation, Private Audit-Before-Decrypt, & Payment Evidence
  it('12-15. Enforces anti-PIN/OTP, AES-256-GCM AAD + key rotation, private-only audit-before-decrypt, and payment_evidence_ref', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '6200',
      username: 'wdu',
      firstName: 'WdUser',
    });

    const { draftToken } = await withdrawalService.startWithdrawalWizard(env, '6200');
    await withdrawalService.handleAmountInput(env, '6200', '100000');
    await withdrawalService.handleMethodSelection(env, '6200', 'KBZPAY');

    // Rejects input containing PIN/OTP/Password
    await expect(
      withdrawalService.handleDestinationInput(env, '6200', 'U Kyaw - 09123456789 OTP: 445566')
    ).rejects.toThrow(/Password, PIN, or OTP/i);

    const destRes = await withdrawalService.handleDestinationInput(
      env,
      '6200',
      'U Kyaw Min - 09451234567'
    );
    expect(destRes.maskedDestination).toBe('***4567');

    const { withdrawal } = await withdrawalService.confirmSubmission(env, {
      customerId: '6200',
      draftToken,
      correlationId: 'cor_wd_1',
    });
    expect(withdrawal.withdrawal_id).toMatch(/^WD-\d{8}-[A-Z0-9]{10}$/);
    expect(withdrawal.destination_ciphertext).not.toContain('09451234567');

    // Group outbox NEVER contains plaintext account number
    const groupOutbox = await db
      .prepare('SELECT payload_json FROM outbox WHERE target_chat_id = ?1')
      .bind(env.TELEGRAM_ADMIN_GROUP_ID)
      .all<{ payload_json: string }>();
    for (const r of groupOutbox.results) {
      expect(r.payload_json).not.toContain('09451234567');
    }

    // AES-256-GCM key rotation (v1 ciphertext decryptable when v2 active & v1 previous) + tamper AAD rejection
    const decryptedRotated = await decryptPayoutDestination(
      withdrawal.destination_ciphertext,
      withdrawal.destination_iv,
      { customerId: '6200', methodCode: 'KBZPAY', keyVersion: 1 },
      { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 2 }
    );
    expect(decryptedRotated).toBe('U Kyaw Min - 09451234567');

    await expect(
      decryptPayoutDestination(
        withdrawal.destination_ciphertext,
        withdrawal.destination_iv,
        { customerId: '9999', methodCode: 'KBZPAY', keyVersion: 1 },
        { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 2 }
      )
    ).rejects.toThrow();

    const encV2 = await encryptPayoutDestination('Daw Hla - 09777888999', TEST_AES_KEY_V2, {
      customerId: '6200',
      methodCode: 'WAVEPAY',
      keyVersion: 2,
    });
    expect(encV2.keyVersion).toBe(2);

    // SUPPORT_AGENT cannot decrypt PII
    await expect(
      withdrawalService.decryptDestinationForSuperAdmin(env, {
        adminId: '9002',
        withdrawalId: withdrawal.withdrawal_id,
        requestChatId: '9002',
        correlationId: 'cor_pii_1',
      })
    ).rejects.toThrow(/SUPER_ADMIN/i);

    // SUPER_ADMIN blocked from decrypting in group chat
    await expect(
      withdrawalService.decryptDestinationForSuperAdmin(env, {
        adminId: '9001',
        withdrawalId: withdrawal.withdrawal_id,
        requestChatId: env.TELEGRAM_ADMIN_GROUP_ID,
        correlationId: 'cor_pii_2',
      })
    ).rejects.toThrow(/group chat/i);

    // SUPER_ADMIN decrypts in private chat & immutable audit record exists
    const decrypted = await withdrawalService.decryptDestinationForSuperAdmin(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      requestChatId: '9001',
      correlationId: 'cor_pii_3',
    });
    expect(decrypted.plaintextDestination).toBe('U Kyaw Min - 09451234567');

    const piiAudit = await db
      .prepare(`SELECT action FROM audit_logs WHERE resource_id = ?1 AND action = 'WITHDRAWAL_DESTINATION_PII_DECRYPTED'`)
      .bind(withdrawal.withdrawal_id)
      .first<{ action: string }>();
    expect(piiAudit).not.toBeNull();

    // Cannot mark PAID_RECORDED without payment_evidence_ref
    await expect(
      withdrawalService.submitSuperAdminDecision(env, {
        adminId: '9001',
        withdrawalId: withdrawal.withdrawal_id,
        newStatus: 'PAID_RECORDED',
        paymentEvidenceRef: '',
        expectedVersion: 1,
        correlationId: 'cor_wd_paid_fail',
      })
    ).rejects.toThrow(/payment_evidence_ref/i);

    // Mark PAID_RECORDED with evidence ref
    const paid = await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'PAID_RECORDED',
      paymentEvidenceRef: 'KBZ-PAYOUT-TXN-776655',
      expectedVersion: 1,
      correlationId: 'cor_wd_paid_ok',
    });
    expect(paid.status).toBe('PAID_RECORDED');
    expect(paid.payment_evidence_ref).toBe('KBZ-PAYOUT-TXN-776655');

    // Customer cancellation immediately redacts ciphertext
    const { draftToken: dt2 } = await withdrawalService.startWithdrawalWizard(env, '6200');
    await withdrawalService.handleAmountInput(env, '6200', '20000');
    await withdrawalService.handleMethodSelection(env, '6200', 'KBZPAY');
    await withdrawalService.handleDestinationInput(env, '6200', 'U Kyaw - 09111222333');
    const { withdrawal: w2 } = await withdrawalService.confirmSubmission(env, {
      customerId: '6200',
      draftToken: dt2,
      correlationId: 'cor_wd_cancel_sub',
    });

    const cancelled = await withdrawalService.cancelByCustomer(env, {
      customerId: '6200',
      withdrawalId: w2.withdrawal_id,
      correlationId: 'cor_wd_cancel_exec',
    });
    expect(cancelled.status).toBe('CANCELLED_BY_CUSTOMER');
    expect(cancelled.destination_ciphertext).toBe('REDACTED');
    expect(cancelled.destination_iv).toBe('REDACTED');
  });

  // 16 & 17. Duplicate Slip Detection & Human Slip Verification Decisions
  it('16 & 17. Flags duplicate payment slips across customers and enforces reason on REJECTED/NEEDS_INFO', async () => {
    const first = await slipService.ingestCustomerSlipPhoto(env, {
      customerId: '6301',
      customerFirstName: 'SlipOne',
      customerUsername: 's1',
      telegramMessageId: 101,
      updateId: 3001,
      fileId: 'FILE_ID_1',
      fileUniqueId: 'UNIQUE_SLIP_HASH_001',
      caption: 'My deposit slip',
      correlationId: 'cor_slp_1',
    });
    expect(first.isDuplicateWarning).toBe(false);

    const second = await slipService.ingestCustomerSlipPhoto(env, {
      customerId: '6302',
      customerFirstName: 'SlipTwo',
      customerUsername: 's2',
      telegramMessageId: 102,
      updateId: 3002,
      fileId: 'FILE_ID_2',
      fileUniqueId: 'UNIQUE_SLIP_HASH_001',
      caption: 'Reused slip',
      correlationId: 'cor_slp_2',
    });
    expect(second.isDuplicateWarning).toBe(true);
    expect(second.slip.duplicate_context_json).toContain('6301');

    // Reject without note fails
    await expect(
      slipService.submitAdminSlipDecision(env, {
        adminId: '9002',
        slipId: second.slip.slip_id,
        decision: 'REJECTED',
        expectedVersion: 1,
        correlationId: 'cor_slp_3',
      })
    ).rejects.toThrow(/review note is mandatory/i);

    // Reject with note succeeds
    const dec = await slipService.submitAdminSlipDecision(env, {
      adminId: '9002',
      slipId: second.slip.slip_id,
      decision: 'REJECTED',
      reviewNote: 'Duplicate slip previously submitted by customer 6301',
      expectedVersion: 1,
      correlationId: 'cor_slp_4',
    });
    expect(dec.review_status).toBe('REJECTED');
    expect(dec.version).toBe(2);
  });

  // 18. Outbox Queue Consumer: 200 SENT, 429 Retryable, Timeout -> DELIVERY_UNCERTAIN, 403 Group -> Emergency Fallback
  it('18. Handles Telegram 200 SENT, 429 Retryable backoff, Timeout DELIVERY_UNCERTAIN, and 403 Group Emergency Fallback', async () => {
    const nowMs = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_ok', 'k_ok', 'TEST', 'CUSTOMER', '7777', '7777', '7777_ok', 1, 'sendMessage', '{"chat_id":"7777","text":"Hi"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_429', 'k_429', 'TEST', 'CUSTOMER', '7778', '7778', '7778_429', 1, 'sendMessage', '{"chat_id":"7778","text":"RL"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_unc', 'k_unc', 'TEST', 'CUSTOMER', '7779', '7779', '7779_unc', 1, 'sendMessage', '{"chat_id":"7779","text":"TO"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_grp403', 'k_grp403', 'GROUP_ALERT', 'TICKET', 'tkt_x', ?2, 'grp_403', 1, 'sendMessage', '{"chat_id":"-100999888777","text":"Alert"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs, env.TELEGRAM_ADMIN_GROUP_ID),
    ]);

    // 1. 200 OK -> SENT
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 })
    ) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_ok')).outcome).toBe('SENT');

    // 2. 429 -> RETRYABLE_FAILURE
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 12 } }),
        { status: 429 }
      )
    ) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_429')).outcome).toBe('RETRYABLE_FAILURE');

    // 3. Post-send TimeoutError -> DELIVERY_UNCERTAIN (never auto-replayed)
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('The operation timed out');
      err.name = 'TimeoutError';
      throw err;
    }) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_unc')).outcome).toBe('DELIVERY_UNCERTAIN');
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_unc')).outcome).toBe('SKIPPED');

    // 4. 403 on Admin Group -> PERMANENT_FAILURE + Emergency SUPER_ADMIN DM fallback inserted
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }),
        { status: 403 }
      )
    ) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_grp403')).outcome).toBe('PERMANENT_FAILURE');

    const fallbackRow = await db
      .prepare(`SELECT target_chat_id, payload_json FROM outbox WHERE target_chat_id = '9001' AND event_type = 'EMERGENCY_SUPER_ADMIN_FALLBACK'`)
      .first<{ target_chat_id: string; payload_json: string }>();
    expect(fallbackRow).not.toBeNull();
    expect(fallbackRow!.payload_json).toContain('EMERGENCY ADMIN GROUP DELIVERY FAILURE');
  });

  // 19. Scheduled Crons: Lease Recovery, 30m/60m SLA Reminders/Escalations, & Daily Retention/Redaction
  it('19. Executes lease recovery, 30m/60m SLA reminder/escalation, and 30-day withdrawal ciphertext redaction crons', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '6400',
      username: 'cronu',
      firstName: 'CronUser',
    });

    const nowMs = Date.now();
    const expiredMs = nowMs - 120 * 1000;
    const idle45m = nowMs - 45 * 60 * 1000;
    const idle75m = nowMs - 75 * 60 * 1000;
    const past40d = nowMs - 40 * 86400000;

    await db.batch([
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, lease_owner, lease_token, lease_expires_at, created_at, updated_at)
           VALUES ('obx_exp_clm', 'k_clm', 'TEST', 'CUSTOMER', '6400', '6400', '6400_a', 1, 'sendMessage', '{"text":"A"}', 0, 'CLAIMED', 1, 6, ?1, ?1, 'w1', 'lt1', ?1, ?1, ?1)`
        )
        .bind(expiredMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, lease_owner, lease_token, lease_expires_at, created_at, updated_at)
           VALUES ('obx_exp_snd', 'k_snd', 'TEST', 'CUSTOMER', '6400', '6400', '6400_b', 1, 'sendMessage', '{"text":"B"}', 0, 'SENDING', 1, 6, ?1, ?1, 'w2', 'lt2', ?1, ?1, ?1)`
        )
        .bind(expiredMs),
      db
        .prepare(
          `INSERT INTO support_tickets (ticket_id, customer_id, ticket_type, status, assigned_admin_id, assigned_at, last_admin_activity_at, reminder_sent, escalated, version, created_at, updated_at)
           VALUES ('tkt_idle', '6400', 'GENERAL_SUPPORT', 'ASSIGNED', '9002', ?1, ?1, 0, 0, 1, ?1, ?1)`
        )
        .bind(idle45m),
      db
        .prepare(
          `INSERT INTO withdrawal_requests (
             withdrawal_id, idempotency_token, ticket_id, customer_id, amount, currency, method_code,
             destination_masked, destination_ciphertext, destination_iv, encryption_key_version,
             status, payment_evidence_ref, version, created_at, updated_at
           ) VALUES (
             'WD-20250101-OLD0000001', 'tok_old', 'tkt_idle', '6400', 50000, 'MMK', 'KBZPAY',
             '***1234', 'ENC_BLOB', 'IV_BLOB', 1, 'PAID_RECORDED', 'PAY_EVID_1', 2, ?1, ?1
           )`
        )
        .bind(past40d),
    ]);

    const leaseRes = await scheduledDispatcher.runLeaseRecoveryCron(env, nowMs);
    expect(leaseRes.expiredClaimedRecovered).toBe(1);
    expect(leaseRes.expiredSendingMarkedUncertain).toBe(1);

    const clmRow = await db.prepare(`SELECT status FROM outbox WHERE outbox_id = 'obx_exp_clm'`).first<{ status: string }>();
    const sndRow = await db.prepare(`SELECT status FROM outbox WHERE outbox_id = 'obx_exp_snd'`).first<{ status: string }>();
    expect(clmRow!.status).toBe('RETRYABLE_FAILURE');
    expect(sndRow!.status).toBe('DELIVERY_UNCERTAIN');

    // 30-min reminder cron
    const sla1 = await scheduledDispatcher.runReminderAndEscalationCron(env, nowMs);
    expect(sla1.remindersQueued).toBe(1);

    // Move activity back to 75m ago -> 60-min escalation cron
    await db
      .prepare(`UPDATE support_tickets SET last_admin_activity_at = ?1 WHERE ticket_id = 'tkt_idle'`)
      .bind(idle75m)
      .run();
    const sla2 = await scheduledDispatcher.runReminderAndEscalationCron(env, nowMs);
    expect(sla2.escalationsQueued).toBe(1);

    // Daily retention cron redacts old withdrawal ciphertext & writes RETENTION_CLEANUP audit log
    const retRes = await scheduledDispatcher.runRetentionCron(env, nowMs);
    expect(retRes.withdrawalCiphertextsRedacted).toBe(1);

    const wdRow = await db
      .prepare(`SELECT destination_ciphertext, destination_iv FROM withdrawal_requests WHERE withdrawal_id = 'WD-20250101-OLD0000001'`)
      .first<{ destination_ciphertext: string; destination_iv: string }>();
    expect(wdRow!.destination_ciphertext).toBe('REDACTED');
    expect(wdRow!.destination_iv).toBe('REDACTED');

    const retAudit = await db
      .prepare(`SELECT action FROM audit_logs WHERE action = 'RETENTION_CLEANUP'`)
      .first<{ action: string }>();
    expect(retAudit).not.toBeNull();
    expect(enqueuedPayloads.length).toBeGreaterThan(0);
  });

  // 20. Callback 64-Byte UTF-8 Limit, Myanmar Grapheme Chunking & Secret Redaction
  it('20. Enforces Telegram 64-byte callback limit, Myanmar Unicode grapheme-safe chunking, and logger redaction', () => {
    const encoded = encodeCallbackData({
      namespace: 'wd',
      action: 'app',
      targetId: 'WD-20261126-ABCDEF1234',
      version: 3,
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(64);
    const decoded = decodeCallbackData(encoded);
    expect(decoded).toEqual({
      namespace: 'wd',
      action: 'app',
      targetId: 'WD-20261126-ABCDEF1234',
      version: 3,
      extra: undefined,
    });

    expect(() =>
      encodeCallbackData({ namespace: 'wd', action: 'very_long_action', targetId: 'X'.repeat(60), version: 9 })
    ).toThrow(/64-byte/i);

    const myanmarSentence = 'မင်္ဂလာပါ 7777club VIP Gaming မှ ကြိုဆိုပါသည်။ ';
    const chunks = chunkTelegramText(myanmarSentence.repeat(120), 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300);
    }

    const redacted = redactLogObject({
      telegram_bot_token: '123456:SECRET',
      api_key: 'AIzaSyFakeKey',
      nested: { otp: '998877', note: 'Call 09123456789' },
    }) as Record<string, unknown>;
    expect(redacted.telegram_bot_token).toBe('[REDACTED]');
    expect(redacted.api_key).toBe('[REDACTED]');
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.otp).toBe('[REDACTED]');
    expect(nested.note).not.toContain('09123456789');
  });
});
