import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
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
import { telegramService } from '../src/worker/services/telegramService';
import { outboxConsumer } from '../src/worker/queues/outboxConsumer';
import { scheduledDispatcher } from '../src/worker/scheduled/dispatcher';
import { auditRepository } from '../src/worker/repositories/auditRepository';
import { outboxRepository } from '../src/worker/repositories/outboxRepository';
import { adminRepository } from '../src/worker/repositories/adminRepository';
import workerEntry from '../src/worker/index';
import {
  encryptPayoutDestination,
  decryptPayoutDestination,
  parseAes256KeyBytes,
} from '../src/worker/lib/crypto';
import { encodeCallbackData, decodeCallbackData } from '../src/worker/lib/callbackCodec';
import { chunkTelegramText, escapeHtml } from '../src/worker/lib/textChunker';
import { redactLogObject } from '../src/worker/lib/logger';
import { containsForbiddenFinancialCommitment } from '../src/worker/schemas/geminiSchemas';
import {
  CONFIRMED_STAGING_D1_DATABASE_ID,
  CONFIRMED_STAGING_D1_DATABASE_NAME,
  CONFIRMED_STAGING_DLQ,
  CONFIRMED_STAGING_PRIMARY_QUEUE,
  DASHBOARD_MANAGED_VAR_KEYS,
  EXPECTED_PRODUCTION_WORKER_NAME,
  EXPECTED_ROOT_WORKER_NAME,
  EXPECTED_STAGING_WORKER_NAME,
  OPTIONAL_ROTATION_SECRET_KEYS,
  REQUIRED_SECRET_KEYS,
  REQUIRED_STATIC_VAR_KEYS,
  enforceDeploymentGate,
  validateWranglerDeploymentConfig,
  type WranglerRootConfig,
} from '../src/worker/lib/deploymentGuard';
import { runPredeployCheck } from '../scripts/predeploy-check';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

// Valid 32-byte random-pattern base64 keys for AES-256-GCM testing (not production secrets)
const TEST_AES_KEY_V1 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const TEST_AES_KEY_V2 = 'ISAiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';

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

    // AES-256-GCM key rotation (v1 ciphertext decryptable when v2 active & v1 previous) + per-record AAD tamper rejection
    const decryptedRotated = await decryptPayoutDestination(
      withdrawal.destination_ciphertext,
      withdrawal.destination_iv,
      {
        purpose: 'withdrawal_destination',
        customerId: '6200',
        recordToken: withdrawal.idempotency_token,
        methodCode: 'KBZPAY',
        keyVersion: 1,
      },
      { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 2 }
    );
    expect(decryptedRotated).toBe('U Kyaw Min - 09451234567');

    // Wrong customerId AAD rejected
    await expect(
      decryptPayoutDestination(
        withdrawal.destination_ciphertext,
        withdrawal.destination_iv,
        {
          purpose: 'withdrawal_destination',
          customerId: '9999',
          recordToken: withdrawal.idempotency_token,
          methodCode: 'KBZPAY',
          keyVersion: 1,
        },
        { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 2 }
      )
    ).rejects.toThrow();

    // Swapped recordToken AAD rejected (cross-record ciphertext transplant protection)
    await expect(
      decryptPayoutDestination(
        withdrawal.destination_ciphertext,
        withdrawal.destination_iv,
        {
          purpose: 'withdrawal_destination',
          customerId: '6200',
          recordToken: 'wdt_different_record_token',
          methodCode: 'KBZPAY',
          keyVersion: 1,
        },
        { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 2 }
      )
    ).rejects.toThrow();

    const encV2 = await encryptPayoutDestination('Daw Hla - 09777888999', TEST_AES_KEY_V2, {
      purpose: 'withdrawal_destination',
      customerId: '6200',
      recordToken: 'wdt_v2_record_01',
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

    // Strict state machine: direct SUBMITTED -> PAID_RECORDED is forbidden
    await expect(
      withdrawalService.submitSuperAdminDecision(env, {
        adminId: '9001',
        withdrawalId: withdrawal.withdrawal_id,
        newStatus: 'PAID_RECORDED',
        paymentEvidenceRef: 'KBZ-PAYOUT-TXN-EARLY',
        expectedVersion: 1,
        correlationId: 'cor_wd_skip_fail',
      })
    ).rejects.toThrow(/not in an allowed state|concurrently/i);

    // Strict flow: SUBMITTED (v1) -> UNDER_REVIEW (v2) -> APPROVED_FOR_PAYOUT (v3) -> PAID_RECORDED (v4)
    const underReview = await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'UNDER_REVIEW',
      expectedVersion: 1,
      correlationId: 'cor_wd_rev',
    });
    expect(underReview.status).toBe('UNDER_REVIEW');
    expect(underReview.version).toBe(2);

    const approvedForPayout = await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'APPROVED_FOR_PAYOUT',
      expectedVersion: 2,
      correlationId: 'cor_wd_app',
    });
    expect(approvedForPayout.status).toBe('APPROVED_FOR_PAYOUT');
    expect(approvedForPayout.version).toBe(3);

    // Cannot mark PAID_RECORDED without payment_evidence_ref
    await expect(
      withdrawalService.submitSuperAdminDecision(env, {
        adminId: '9001',
        withdrawalId: withdrawal.withdrawal_id,
        newStatus: 'PAID_RECORDED',
        paymentEvidenceRef: '',
        expectedVersion: 3,
        correlationId: 'cor_wd_paid_fail',
      })
    ).rejects.toThrow(/payment_evidence_ref/i);

    // Mark PAID_RECORDED with evidence ref from APPROVED_FOR_PAYOUT (v3 -> v4)
    const paid = await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'PAID_RECORDED',
      paymentEvidenceRef: 'KBZ-PAYOUT-TXN-776655',
      expectedVersion: 3,
      correlationId: 'cor_wd_paid_ok',
    });
    expect(paid.status).toBe('PAID_RECORDED');
    expect(paid.payment_evidence_ref).toBe('KBZ-PAYOUT-TXN-776655');
    expect(paid.version).toBe(4);

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

  // 21. Chunked >256KB Webhook Bypass Protection & /healthz Metadata
  it('21. Rejects >256KB webhook body even without Content-Length header and reports bot_username/timezone on /healthz', async () => {
    const app = createApp();

    const healthRes = await app.fetch(new Request('https://bot.example/healthz'), env);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    expect(healthJson.ok).toBe(true);
    expect(healthJson.bot_username).toBe('vip_gaming_support_bot');
    expect(healthJson.timezone).toBe('Asia/Yangon');

    const oversizedBody = JSON.stringify({
      update_id: 99001,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false, first_name: 'ChunkUser' },
        text: 'A'.repeat(270 * 1024),
      },
    });

    // Omit Content-Length explicitly to simulate chunked transfer encoding
    const chunkedRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: oversizedBody,
      }),
      env
    );
    expect(chunkedRes.status).toBe(413);
  });

  // 22. Admin /reject_dep & /reject_wd Commands + Manual Admin Wording Verification
  it('22. Processes /reject_dep and /reject_wd for SUPER_ADMIN, blocks SUPPORT_AGENT, and keeps manual-process wording unambiguous', async () => {
    const app = createApp();
    await customerService.ensureActiveCustomer(env, {
      customerId: '6501',
      username: 'finu',
      firstName: 'FinUser',
      languageCode: 'en',
    });

    // Create 1 deposit to approve (verify manual wording) and 1 deposit to reject via /reject_dep
    const d1 = await depositService.startDepositWizard(env, '6501');
    await depositService.handleAmountInput(env, '6501', '30000');
    await depositService.handleMethodSelection(env, '6501', 'KBZPAY');
    await depositService.handleReferenceInput(env, '6501', 'REF-MANUAL-1');
    const subD1 = await depositService.confirmSubmission(env, {
      customerId: '6501',
      draftToken: d1.draftToken,
      correlationId: 'cor_man_d1',
    });

    await depositService.submitSuperAdminDecision(env, {
      adminId: '9001',
      depositId: subD1.deposit.deposit_id,
      newStatus: 'APPROVED_MANUAL_CREDITED',
      adminEvidenceRef: 'EXT-OP-REF-100',
      expectedVersion: 1,
      correlationId: 'cor_man_d1_app',
    });

    const depNotice = await db
      .prepare(`SELECT payload_json FROM outbox WHERE event_type = 'DEPOSIT_APPROVED_MANUAL_CREDITED' AND aggregate_id = ?1`)
      .bind(subD1.deposit.deposit_id)
      .first<{ payload_json: string }>();
    expect(depNotice).not.toBeNull();
    expect(depNotice!.payload_json).toContain('Manual Process');
    expect(depNotice!.payload_json).toContain('authorized Administrator has verified and recorded manual completion');

    const d2 = await depositService.startDepositWizard(env, '6501');
    await depositService.handleAmountInput(env, '6501', '40000');
    await depositService.handleMethodSelection(env, '6501', 'KBZPAY');
    await depositService.handleReferenceInput(env, '6501', 'REF-REJ-2');
    const subD2 = await depositService.confirmSubmission(env, {
      customerId: '6501',
      draftToken: d2.draftToken,
      correlationId: 'cor_man_d2',
    });

    // Create withdrawal to reject via /reject_wd
    const w1 = await withdrawalService.startWithdrawalWizard(env, '6501');
    await withdrawalService.handleAmountInput(env, '6501', '20000');
    await withdrawalService.handleMethodSelection(env, '6501', 'KBZPAY');
    await withdrawalService.handleDestinationInput(env, '6501', 'U Test - 09444555666');
    const subW1 = await withdrawalService.confirmSubmission(env, {
      customerId: '6501',
      draftToken: w1.draftToken,
      correlationId: 'cor_man_w1',
    });

    // SUPPORT_AGENT (9002) sending /reject_dep and /reject_wd via webhook gets HTTP 200 (no retry loop) + DENIED audit
    const agentRejDepRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99099,
          message: {
            message_id: 9,
            date: 1700000000,
            chat: { id: 9002, type: 'private' },
            from: { id: 9002, is_bot: false, first_name: 'Agent' },
            text: `/reject_dep ${subD2.deposit.deposit_id} 1 Unauthorized attempt`,
          },
        }),
      }),
      env
    );
    expect(agentRejDepRes.status).toBe(200);

    const agentRejWdRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99100,
          message: {
            message_id: 10,
            date: 1700000000,
            chat: { id: 9002, type: 'private' },
            from: { id: 9002, is_bot: false, first_name: 'Agent' },
            text: `/reject_wd ${subW1.withdrawal.withdrawal_id} 1 Unauthorized attempt`,
          },
        }),
      }),
      env
    );
    expect(agentRejWdRes.status).toBe(200);

    const deniedAgentAudits = await db
      .prepare(`SELECT action FROM audit_logs WHERE actor_id = '9002' AND result = 'DENIED'`)
      .all<{ action: string }>();
    expect(deniedAgentAudits.results.map((r) => r.action)).toContain('UNAUTHORIZED_DEPOSIT_DECISION_ATTEMPT');
    expect(deniedAgentAudits.results.map((r) => r.action)).toContain('UNAUTHORIZED_WITHDRAWAL_DECISION_ATTEMPT');

    // SUPER_ADMIN /reject_dep command via webhook
    const rejDepRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99101,
          message: {
            message_id: 11,
            date: 1700000000,
            chat: { id: 9001, type: 'private' },
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            text: `/reject_dep ${subD2.deposit.deposit_id} 1 Invalid <slip> & reference`,
          },
        }),
      }),
      env
    );
    expect(rejDepRes.status).toBe(200);

    const depAfterRej = await db
      .prepare('SELECT status, decision_note FROM deposit_requests WHERE deposit_id = ?1')
      .bind(subD2.deposit.deposit_id)
      .first<{ status: string; decision_note: string }>();
    expect(depAfterRej!.status).toBe('REJECTED');

    // SUPER_ADMIN moves withdrawal SUBMITTED -> UNDER_REVIEW (/review_wd) before /reject_wd
    const revWdRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99102,
          message: {
            message_id: 12,
            date: 1700000000,
            chat: { id: 9001, type: 'private' },
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            text: `/review_wd ${subW1.withdrawal.withdrawal_id} 1`,
          },
        }),
      }),
      env
    );
    expect(revWdRes.status).toBe(200);

    // SUPER_ADMIN /reject_wd command via webhook (now version 2, UNDER_REVIEW -> REJECTED)
    const rejWdRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99103,
          message: {
            message_id: 13,
            date: 1700000000,
            chat: { id: 9001, type: 'private' },
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            text: `/reject_wd ${subW1.withdrawal.withdrawal_id} 2 Name mismatch <check>`,
          },
        }),
      }),
      env
    );
    expect(rejWdRes.status).toBe(200);

    const wdAfterRej = await db
      .prepare('SELECT status FROM withdrawal_requests WHERE withdrawal_id = ?1')
      .bind(subW1.withdrawal.withdrawal_id)
      .first<{ status: string }>();
    expect(wdAfterRej!.status).toBe('REJECTED');

    // Verify HTML special chars in rejection reason were escaped cleanly in customer outbox
    const rejOutbox = await db
      .prepare(`SELECT payload_json FROM outbox WHERE event_type = 'DEPOSIT_REJECTED' AND aggregate_id = ?1`)
      .bind(subD2.deposit.deposit_id)
      .first<{ payload_json: string }>();
    expect(rejOutbox!.payload_json).toContain('&lt;slip&gt; &amp; reference');
    expect(rejOutbox!.payload_json).not.toContain('<slip>');
  });

  // 23. Withdrawal Destination PII Never Enters messages Table or Gemini Prompt + has_started_bot Guard on wd:pii
  it('23. Guarantees raw withdrawal destination never enters messages or Gemini prompt and requires private /start before wd:pii decrypt', async () => {
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();
    const cust = await customerService.ensureActiveCustomer(env, {
      customerId: '6502',
      username: 'piitest',
      firstName: 'Pii<User>&Co',
    });

    await withdrawalService.startWithdrawalWizard(env, '6502');
    await customerService.handleCustomerText(env, {
      customer: cust,
      telegramMessageId: 201,
      updateId: 99201,
      text: '35000',
      correlationId: 'cor_piiw_1',
    });
    await withdrawalService.handleMethodSelection(env, '6502', 'KBZPAY');
    await customerService.handleCustomerText(env, {
      customer: cust,
      telegramMessageId: 202,
      updateId: 99202,
      text: 'U Secret Account 09888777666',
      correlationId: 'cor_piiw_2',
    });

    // Verify plaintext destination is NOT persisted in messages table
    const storedMsgs = await db
      .prepare(`SELECT text_content FROM messages WHERE customer_id = '6502'`)
      .all<{ text_content: string | null }>();
    for (const m of storedMsgs.results) {
      expect(m.text_content ?? '').not.toContain('09888777666');
    }

    // Clear session and send normal AI message; verify Gemini prompt never sees payout number
    await db.prepare(`DELETE FROM customer_sessions WHERE customer_id = '6502'`).run();
    let geminiRequestBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      geminiRequestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      replyText: 'How can I help you today?',
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
      customer: cust,
      telegramMessageId: 203,
      updateId: 99203,
      text: 'What games do you have?',
      correlationId: 'cor_piiw_3',
    });
    expect(geminiRequestBody).not.toContain('09888777666');

    // Verify wd:pii callback rejects SUPER_ADMIN with has_started_bot = 0 before decrypting
    await db.prepare(`UPDATE admins SET has_started_bot = 0 WHERE telegram_user_id = '9001'`).run();
    let answerCallbackText = '';
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('answerCallbackQuery')) {
        answerCallbackText = String(init?.body ?? '');
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    const app = createApp();
    const cbRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99204,
          callback_query: {
            id: 'cb_pii_unstarted',
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            data: encodeCallbackData({ namespace: 'wd', action: 'pii', targetId: 'WD-20261126-ABCDEF1234', version: 1 }),
          },
        }),
      }),
      env
    );
    expect(cbRes.status).toBe(200);
    expect(answerCallbackText).toContain('@vip_gaming_support_bot');
    expect(answerCallbackText).toContain('/start');
  });

  // 24. Full Retention Cron & processed_queue_events Tracking
  it('24. Enforces all retention windows (messages, unreferenced fingerprints, audit_logs >=301d, sessions, queue events) and records processed_queue_events', async () => {
    await customerService.ensureActiveCustomer(env, {
      customerId: '6600',
      username: 'retuser',
      firstName: 'RetUser',
    });

    const nowMs = Date.now();
    const old200d = nowMs - 200 * 86400000;
    const old400d = nowMs - 400 * 86400000;
    const expiredMs = nowMs - 60000;

    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (message_id, customer_id, direction, sender_role, sender_id, message_type, text_content, is_potential_slip, include_in_ai_context, delivery_status, created_at)
           VALUES ('msg_old_200d', '6600', 'INBOUND', 'USER', '6600', 'TEXT', 'old msg', 0, 1, 'RECEIVED', ?1)`
        )
        .bind(old200d),
      db
        .prepare(
          `INSERT INTO slip_fingerprints (
             file_unique_id, first_customer_id, first_slip_id, first_ticket_id, first_seen_at,
             occurrence_count, last_customer_id, last_slip_id, last_seen_at
           ) VALUES ('FP_OLD_UNREF', '6600', 'slp_old', 'tkt_old', ?1, 1, '6600', 'slp_old', ?1)`
        )
        .bind(old400d),
      db
        .prepare(
          `INSERT INTO admin_sessions (admin_id, session_state, expires_at, updated_at)
           VALUES ('9002', 'IDLE', ?1, ?1)`
        )
        .bind(expiredMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_qev_track', 'k_qev_track', 'TEST', 'CUSTOMER', '6600', '6600', '6600_qev', 1, 'sendMessage', '{"chat_id":"6600","text":"Hi"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO processed_queue_events (event_id, outbox_id, consumer_lease_token, outcome, processed_at, expires_at)
           VALUES ('qev_expired_1', 'obx_qev_track', 'lt_old', 'COMPLETED', ?1, ?1)`
        )
        .bind(expiredMs),
    ]);

    // Insert an old >365d audit row and verify retention deletes it without violating 300d trigger
    await auditRepository.appendImmediate(db, {
      actorId: 'SYSTEM',
      actorRole: 'SYSTEM',
      action: 'ANCIENT_AUDIT_EVENT',
      resourceType: 'SYSTEM',
      resourceId: 'SYS',
      result: 'SUCCESS',
      correlationId: 'cor_old_audit',
      nowMs: old400d,
    });

    // Verify outboxConsumer records processed_queue_events
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 })
    ) as typeof globalThis.fetch;
    const consRes = await outboxConsumer.processSingleOutbox(env, 'obx_qev_track', 'cor_qev', 'qev_live_1', nowMs);
    expect(consRes.outcome).toBe('SENT');
    const trackedQev = await db
      .prepare(`SELECT outcome FROM processed_queue_events WHERE event_id = 'qev_live_1'`)
      .first<{ outcome: string }>();
    expect(trackedQev?.outcome).toBe('COMPLETED');

    const ret = await scheduledDispatcher.runRetentionCron(env, nowMs);
    expect(ret.expiredMessagesDeleted).toBe(1);
    expect(ret.expiredFingerprintsDeleted).toBe(1);
    expect(ret.expiredAdminSessionsDeleted).toBe(1);
    expect(ret.expiredQueueEventsDeleted).toBe(1);
    expect(ret.expiredAuditLogsDeleted).toBe(1);
  });

  // 25. Cloudflare wrangler.jsonc (Phase 6.3 Zero-Root-Binding + Isolated Staging + Dashboard-Managed Variables) & .env.example Configuration Parity
  it('25. Verifies Phase 6.3 zero-root-binding isolation, env.staging exclusive staging config, keep_vars: true, Dashboard-managed vars omission, cron triggers, and .env.example parity', () => {
    const wranglerRaw = fs.readFileSync(path.resolve(process.cwd(), 'wrangler.jsonc'), 'utf8');
    const wranglerCfg = JSON.parse(wranglerRaw) as WranglerRootConfig;

    // 1. Top-level Worker identity preserved as auto-reply-bot & keep_vars: true at root only
    expect(wranglerCfg.name).toBe(EXPECTED_ROOT_WORKER_NAME);
    expect(wranglerCfg.keep_vars).toBe(true);

    // 2. Root scope contains ZERO D1 bindings, Queue bindings, runtime vars, or Cron triggers
    expect(wranglerCfg.vars).toBeUndefined();
    expect(wranglerCfg.d1_databases).toBeUndefined();
    expect(wranglerCfg.queues).toBeUndefined();
    expect(wranglerCfg.triggers).toBeUndefined();
    expect(wranglerCfg.build?.command).toContain('scripts/predeploy-check.ts --target=top-level');

    // 3. keep_vars must NOT be placed inside named environments
    expect(wranglerCfg.env?.staging).toBeDefined();
    expect(wranglerCfg.env?.production).toBeDefined();
    expect(wranglerCfg.env?.staging).not.toHaveProperty('keep_vars');
    expect(wranglerCfg.env?.production).not.toHaveProperty('keep_vars');
    expect(wranglerCfg.env?.staging?.build?.command).toContain('scripts/predeploy-check.ts --target=staging');
    expect(wranglerCfg.env?.production?.build?.command).toContain('scripts/predeploy-check.ts --target=production');

    // 4. Environment separation: env.staging is "staging", env.production is "production"
    expect(wranglerCfg.env?.staging?.vars?.ENVIRONMENT).toBe('staging');
    expect(wranglerCfg.env?.production?.vars?.ENVIRONMENT).toBe('production');

    // 5. The three Dashboard-managed variables and all secrets are omitted from every Wrangler vars block
    const allVarsBlocks = [
      wranglerCfg.env?.staging?.vars ?? {},
      wranglerCfg.env?.production?.vars ?? {},
    ];
    for (const varsBlock of allVarsBlocks) {
      for (const dashboardKey of DASHBOARD_MANAGED_VAR_KEYS) {
        expect(varsBlock).not.toHaveProperty(dashboardKey);
      }
      for (const secretKey of [...REQUIRED_SECRET_KEYS, ...OPTIONAL_ROTATION_SECRET_KEYS]) {
        expect(varsBlock).not.toHaveProperty(secretKey);
      }
      for (const val of Object.values(varsBlock)) {
        expect(String(val)).not.toMatch(/CONFIGURED_IN_CLOUDFLARE_ENV|PENDING_OWNER_CONFIRMATION|PENDING_OWNER_CONFIGURATION/i);
      }
      for (const staticKey of REQUIRED_STATIC_VAR_KEYS) {
        expect(typeof varsBlock[staticKey]).toBe('string');
        expect(String(varsBlock[staticKey]).trim().length).toBeGreaterThan(0);
      }
    }

    const expectedCrons = ['* * * * *'];
    expect(wranglerCfg.env?.staging?.triggers?.crons).toEqual(expectedCrons);
    expect(wranglerCfg.env?.production?.triggers?.crons).toEqual(expectedCrons);

    // Ensure removed unused SLA env vars are gone
    expect(wranglerCfg.env?.staging?.vars).not.toHaveProperty('SUPPORT_REMINDER_MINUTES');
    expect(wranglerCfg.env?.staging?.vars).not.toHaveProperty('SUPPORT_ESCALATION_MINUTES');

    // Parse .env.example non-secret vars and verify retention defaults & required secret declarations
    const envExampleRaw = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    const envMap: Record<string, string> = {};
    for (const line of envExampleRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        envMap[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
    }

    expect(envMap).not.toHaveProperty('SUPPORT_REMINDER_MINUTES');
    expect(envMap).not.toHaveProperty('SUPPORT_ESCALATION_MINUTES');
    expect(envMap.RETENTION_MESSAGES_DAYS).toBe(wranglerCfg.env?.staging?.vars?.RETENTION_MESSAGES_DAYS);
    expect(envMap.RETENTION_FINGERPRINTS_DAYS).toBe(wranglerCfg.env?.staging?.vars?.RETENTION_FINGERPRINTS_DAYS);
    expect(envMap.RETENTION_AUDIT_DAYS).toBe(wranglerCfg.env?.staging?.vars?.RETENTION_AUDIT_DAYS);
    expect(envMap.RETENTION_WITHDRAWAL_PII_DAYS).toBe(wranglerCfg.env?.staging?.vars?.RETENTION_WITHDRAWAL_PII_DAYS);
    expect(envMap.RETENTION_OUTBOX_DAYS).toBe(wranglerCfg.env?.staging?.vars?.RETENTION_OUTBOX_DAYS);

    // Ensure .env.example documents Dashboard-managed variables with placeholders and all 6 required/optional Secret names with empty values
    expect(envMap.TELEGRAM_BOT_USERNAME).toBe('<TELEGRAM_BOT_USERNAME>');
    expect(envMap.TELEGRAM_ADMIN_GROUP_ID).toBe('<TELEGRAM_ADMIN_GROUP_ID>');
    expect(envMap.SUPER_ADMIN_IDS).toBe('<SUPER_ADMIN_TELEGRAM_USER_IDS>');
    for (const reqSecret of REQUIRED_SECRET_KEYS) {
      expect(envMap).toHaveProperty(reqSecret);
      expect(envMap[reqSecret]).toBe('');
    }
    for (const optSecret of OPTIONAL_ROTATION_SECRET_KEYS) {
      expect(envMap).toHaveProperty(optSecret);
      expect(envMap[optSecret]).toBe('');
    }

    // Verify isolated staging and production D1 & Queue bindings (including DLQ max_retries: 0)
    expect(wranglerCfg.env?.staging?.d1_databases?.[0]?.binding).toBe('DB');
    expect(wranglerCfg.env?.staging?.d1_databases?.[0]?.database_name).toBe(CONFIRMED_STAGING_D1_DATABASE_NAME);
    expect(wranglerCfg.env?.staging?.d1_databases?.[0]?.database_id).toBe(CONFIRMED_STAGING_D1_DATABASE_ID);
    expect(wranglerCfg.env?.production?.d1_databases?.[0]?.binding).toBe('DB');
    expect(wranglerCfg.env?.production?.d1_databases?.[0]?.database_name).toBe('vip-gaming-d1-prod');
    expect(wranglerCfg.env?.production?.d1_databases?.[0]?.database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(wranglerCfg.env?.staging?.queues?.producers?.[0]?.binding).toBe('OUTBOX_QUEUE');
    expect(wranglerCfg.env?.staging?.queues?.producers?.[0]?.queue).toBe(CONFIRMED_STAGING_PRIMARY_QUEUE);
    const stagingDlq = wranglerCfg.env?.staging?.queues?.consumers?.find((c) => c.queue === CONFIRMED_STAGING_DLQ);
    const prodDlq = wranglerCfg.env?.production?.queues?.consumers?.find((c) => c.queue === 'vip-outbox-dlq-prod');
    expect(stagingDlq).toBeDefined();
    expect(stagingDlq!.max_retries).toBe(0);
    expect(prodDlq).toBeDefined();
    expect(prodDlq!.max_retries).toBe(0);
  });

  // 26. F-01: Bootstrap SUPER_ADMIN starts with has_started_bot = 0 and activates via private /start [payload]
  it('26. F-01: Bootstraps SUPER_ADMIN with has_started_bot=0, blocks claim/PII until private /start [payload], and preserves flag on re-bootstrap', async () => {
    const app = createApp();
    const envWithNewSuper: Env = { ...env, SUPER_ADMIN_IDS: '9001,9990' };

    await adminService.ensureBootstrapSuperAdmins(envWithNewSuper);
    const bootstrapped = await adminRepository.getById(db, '9990');
    expect(bootstrapped).not.toBeNull();
    expect(bootstrapped!.role).toBe('SUPER_ADMIN');
    expect(bootstrapped!.has_started_bot).toBe(0);
    expect(bootstrapped!.last_seen_at).toBeNull();

    // Unstarted SUPER_ADMIN cannot claim ticket
    await customerService.ensureActiveCustomer(envWithNewSuper, {
      customerId: '7101',
      username: 'u7101',
      firstName: 'U7101',
    });
    const { ticket } = await handoverService.escalateCustomerToHuman(envWithNewSuper, {
      customerId: '7101',
      customerFirstName: 'U7101',
      customerUsername: 'u7101',
      ticketType: 'GENERAL_SUPPORT',
      summaryText: 'Help',
      reason: 'Test',
      correlationId: 'cor_f01_tkt',
    });
    await expect(
      handoverService.takeOverTicket(envWithNewSuper, {
        adminId: '9990',
        ticketId: ticket.ticket_id,
        expectedVersion: 1,
        correlationId: 'cor_f01_claim_fail',
      })
    ).rejects.toThrow(/\/start/i);

    // Send /start with deep-link payload in private chat -> sets has_started_bot = 1
    const startRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99301,
          message: {
            message_id: 1,
            date: 1700000000,
            chat: { id: 9990, type: 'private' },
            from: { id: 9990, is_bot: false, first_name: 'BootstrapSA' },
            text: '/start onboarding_ref',
          },
        }),
      }),
      envWithNewSuper
    );
    expect(startRes.status).toBe(200);

    const afterStart = await adminRepository.getById(db, '9990');
    expect(afterStart!.has_started_bot).toBe(1);
    expect(afterStart!.last_seen_at).not.toBeNull();

    // Re-running upsertBootstrapSuperAdmin preserves has_started_bot = 1
    await adminRepository.upsertBootstrapSuperAdmin(db, '9990', 'BootstrapSA', 'tok_reboot', Date.now());
    const afterReboot = await adminRepository.getById(db, '9990');
    expect(afterReboot!.has_started_bot).toBe(1);
  });

  // 27. F-02: Admin webhook command domain/auth errors return HTTP 200 (no poison retry loop)
  it('27. F-02: Returns HTTP 200 and marks processed_updates COMPLETED when admin commands fail auth/validation/not-found', async () => {
    const app = createApp();
    const commands = [
      { updateId: 99401, fromId: 9002, text: '/toggle_ai' },
      { updateId: 99402, fromId: 9002, text: '/approve_dep DEP-20261126-MISSING001 1 REF1' },
      { updateId: 99403, fromId: 9002, text: '/paid_wd WD-20261126-MISSING001 1 PAY1' },
      { updateId: 99404, fromId: 9002, text: '/view_wd_pii WD-20261126-MISSING001' },
      { updateId: 99405, fromId: 9001, text: '/approve_dep DEP-20261126-MISSING001 1 REF1' },
    ];

    for (const cmd of commands) {
      const res = await app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            update_id: cmd.updateId,
            message: {
              message_id: cmd.updateId,
              date: 1700000000,
              chat: { id: cmd.fromId, type: 'private' },
              from: { id: cmd.fromId, is_bot: false, first_name: 'Admin' },
              text: cmd.text,
            },
          }),
        }),
        env
      );
      expect(res.status).toBe(200);
      const upd = await db
        .prepare('SELECT status FROM processed_updates WHERE update_id = ?1')
        .bind(cmd.updateId)
        .first<{ status: string }>();
      expect(upd!.status).toBe('COMPLETED');
    }

    // RBAC-before-lookup: SUPPORT_AGENT got DENIED audit even on non-existent deposit/withdrawal IDs
    const denied = await db
      .prepare(`SELECT action FROM audit_logs WHERE actor_id = '9002' AND result = 'DENIED'`)
      .all<{ action: string }>();
    const actions = denied.results.map((r) => r.action);
    expect(actions).toContain('UNAUTHORIZED_CONFIG_TOGGLE_AI_ATTEMPT');
    expect(actions).toContain('UNAUTHORIZED_DEPOSIT_DECISION_ATTEMPT');
    expect(actions).toContain('UNAUTHORIZED_WITHDRAWAL_DECISION_ATTEMPT');
    expect(actions).toContain('UNAUTHORIZED_WITHDRAWAL_PII_DECRYPT_ATTEMPT');
  });

  // 28. F-03: End-to-End Admin Private Console Card, Callbacks (tk:reply, dep:app/rej/info, wd:rev/app/paid/rej/info), Admin Sessions, & /cancel
  it('28. F-03: Delivers private console on claim and executes tk:reply, deposit/withdrawal callbacks, admin sessions, and /cancel end-to-end', async () => {
    const app = createApp();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })) as typeof globalThis.fetch;

    const postWebhook = async (body: Record<string, unknown>) =>
      app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify(body),
        }),
        env
      );

    await customerService.ensureActiveCustomer(env, {
      customerId: '7201',
      username: 'u7201',
      firstName: 'ConsoleCustomer',
      languageCode: 'en',
    });

    // Customer submits deposit + withdrawal
    const depDraft = await depositService.startDepositWizard(env, '7201');
    await depositService.handleAmountInput(env, '7201', '25000');
    await depositService.handleMethodSelection(env, '7201', 'KBZPAY');
    await depositService.handleReferenceInput(env, '7201', 'DEP-CB-REF-1');
    const { deposit } = await depositService.confirmSubmission(env, {
      customerId: '7201',
      draftToken: depDraft.draftToken,
      correlationId: 'cor_f03_dep',
    });

    const wdDraft = await withdrawalService.startWithdrawalWizard(env, '7201');
    await withdrawalService.handleAmountInput(env, '7201', '15000');
    await withdrawalService.handleMethodSelection(env, '7201', 'KBZPAY');
    await withdrawalService.handleDestinationInput(env, '7201', 'U Mg Mg - 09450001122');
    const { withdrawal } = await withdrawalService.confirmSubmission(env, {
      customerId: '7201',
      draftToken: wdDraft.draftToken,
      correlationId: 'cor_f03_wd',
    });

    // SUPER_ADMIN claims ticket -> private console card sent to 9001
    expect(
      (
        await postWebhook({
          update_id: 99501,
          callback_query: {
            id: 'cb_f03_claim',
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            data: encodeCallbackData({ namespace: 'tk', action: 'claim', targetId: deposit.ticket_id, version: 1 }),
          },
        })
      ).status
    ).toBe(200);

    const consoleOutbox = await db
      .prepare(`SELECT payload_json FROM outbox WHERE target_chat_id = '9001' AND event_type = 'ADMIN_PRIVATE_CONSOLE'`)
      .first<{ payload_json: string }>();
    expect(consoleOutbox).not.toBeNull();
    expect(consoleOutbox!.payload_json).toContain('wd:rev:');
    expect(consoleOutbox!.payload_json).toContain('dep:app:');

    // tk:reply callback -> admin private text sends reply to customer
    expect(
      (
        await postWebhook({
          update_id: 99502,
          callback_query: {
            id: 'cb_f03_reply',
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            data: encodeCallbackData({ namespace: 'tk', action: 'reply', targetId: deposit.ticket_id, version: 2 }),
          },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await postWebhook({
          update_id: 99503,
          message: {
            message_id: 503,
            date: 1700000000,
            chat: { id: 9001, type: 'private' },
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            text: 'We are reviewing your requests now.',
          },
        })
      ).status
    ).toBe(200);

    const adminReplyOutbox = await db
      .prepare(`SELECT payload_json FROM outbox WHERE target_chat_id = '7201' AND event_type = 'ADMIN_REPLY'`)
      .first<{ payload_json: string }>();
    expect(adminReplyOutbox!.payload_json).toContain('We are reviewing your requests now.');

    // SUPPORT_AGENT (9002) blocked from dep:app and audited DENIED
    await postWebhook({
      update_id: 99504,
      callback_query: {
        id: 'cb_f03_dep_denied',
        from: { id: 9002, is_bot: false, first_name: 'Agent' },
        data: encodeCallbackData({ namespace: 'dep', action: 'app', targetId: deposit.deposit_id, version: 1 }),
      },
    });
    const depDenied = await db
      .prepare(`SELECT action FROM audit_logs WHERE actor_id = '9002' AND action = 'UNAUTHORIZED_DEPOSIT_CALLBACK_ATTEMPT'`)
      .first<{ action: string }>();
    expect(depDenied).not.toBeNull();

    // SUPER_ADMIN clicks dep:app -> submits evidence ref in DM -> APPROVED_MANUAL_CREDITED
    await postWebhook({
      update_id: 99505,
      callback_query: {
        id: 'cb_f03_dep_app',
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        data: encodeCallbackData({ namespace: 'dep', action: 'app', targetId: deposit.deposit_id, version: 1 }),
      },
    });
    await postWebhook({
      update_id: 99506,
      message: {
        message_id: 506,
        date: 1700000000,
        chat: { id: 9001, type: 'private' },
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        text: 'MANUAL-CRED-EVID-777',
      },
    });
    const depFinal = await db
      .prepare('SELECT status, admin_operation_evidence_ref FROM deposit_requests WHERE deposit_id = ?1')
      .bind(deposit.deposit_id)
      .first<{ status: string; admin_operation_evidence_ref: string }>();
    expect(depFinal!.status).toBe('APPROVED_MANUAL_CREDITED');
    expect(depFinal!.admin_operation_evidence_ref).toBe('MANUAL-CRED-EVID-777');

    // SUPER_ADMIN runs strict withdrawal callback sequence: wd:rev -> wd:app -> wd:paid + DM evidence ref
    await postWebhook({
      update_id: 99507,
      callback_query: {
        id: 'cb_f03_wd_rev',
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        data: encodeCallbackData({ namespace: 'wd', action: 'rev', targetId: withdrawal.withdrawal_id, version: 1 }),
      },
    });
    await postWebhook({
      update_id: 99508,
      callback_query: {
        id: 'cb_f03_wd_app',
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        data: encodeCallbackData({ namespace: 'wd', action: 'app', targetId: withdrawal.withdrawal_id, version: 2 }),
      },
    });

    // Verify APPROVED_FOR_PAYOUT notice explicitly distinguishes from PAID_RECORDED
    const appNotice = await db
      .prepare(`SELECT payload_json FROM outbox WHERE event_type = 'WITHDRAWAL_APPROVED_FOR_PAYOUT' AND aggregate_id = ?1`)
      .bind(withdrawal.withdrawal_id)
      .first<{ payload_json: string }>();
    expect(appNotice).not.toBeNull();
    expect(appNotice!.payload_json).toContain('NOT been completed yet');

    // Trigger wd:paid, test /cancel clears session, then re-trigger wd:paid and submit evidence
    await postWebhook({
      update_id: 99509,
      callback_query: {
        id: 'cb_f03_wd_paid_1',
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        data: encodeCallbackData({ namespace: 'wd', action: 'paid', targetId: withdrawal.withdrawal_id, version: 3 }),
      },
    });
    await postWebhook({
      update_id: 99510,
      message: {
        message_id: 510,
        date: 1700000000,
        chat: { id: 9001, type: 'private' },
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        text: '/cancel',
      },
    });
    expect(await adminRepository.getSession(db, '9001')).toBeNull();

    await postWebhook({
      update_id: 99511,
      callback_query: {
        id: 'cb_f03_wd_paid_2',
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        data: encodeCallbackData({ namespace: 'wd', action: 'paid', targetId: withdrawal.withdrawal_id, version: 3 }),
      },
    });
    await postWebhook({
      update_id: 99512,
      message: {
        message_id: 512,
        date: 1700000000,
        chat: { id: 9001, type: 'private' },
        from: { id: 9001, is_bot: false, first_name: 'Super' },
        text: 'KBZ-EXT-PAYOUT-999',
      },
    });
    const wdFinal = await db
      .prepare('SELECT status, payment_evidence_ref FROM withdrawal_requests WHERE withdrawal_id = ?1')
      .bind(withdrawal.withdrawal_id)
      .first<{ status: string; payment_evidence_ref: string }>();
    expect(wdFinal!.status).toBe('PAID_RECORDED');
    expect(wdFinal!.payment_evidence_ref).toBe('KBZ-EXT-PAYOUT-999');
  });

  // 29. F-03: Customer Cancellation (dep:creq, wd:creq) & NEEDS_INFO Customer Reply (dep:rinfo, wd:rinfo)
  it('29. F-03: Supports idempotent customer cancellation and NEEDS_INFO reply sessions with anti-secret protection and include_in_ai_context=0', async () => {
    const app = createApp();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })) as typeof globalThis.fetch;

    const postWebhook = async (body: Record<string, unknown>) =>
      app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify(body),
        }),
        env
      );

    await customerService.ensureActiveCustomer(env, {
      customerId: '7301',
      username: 'u7301',
      firstName: 'CancelUser',
      languageCode: 'en',
    });

    // Deposit cancellation via dep:creq (idempotent on repeat)
    const dDraft = await depositService.startDepositWizard(env, '7301');
    await depositService.handleAmountInput(env, '7301', '12000');
    await depositService.handleMethodSelection(env, '7301', 'KBZPAY');
    await depositService.handleReferenceInput(env, '7301', 'CNCL-REF-1');
    const { deposit } = await depositService.confirmSubmission(env, {
      customerId: '7301',
      draftToken: dDraft.draftToken,
      correlationId: 'cor_cncl_d1',
    });

    await postWebhook({
      update_id: 99601,
      callback_query: {
        id: 'cb_dep_creq_1',
        from: { id: 7301, is_bot: false, first_name: 'CancelUser' },
        data: encodeCallbackData({ namespace: 'dep', action: 'creq', targetId: deposit.deposit_id, version: 1 }),
      },
    });
    // Repeat click is idempotent
    await postWebhook({
      update_id: 99602,
      callback_query: {
        id: 'cb_dep_creq_2',
        from: { id: 7301, is_bot: false, first_name: 'CancelUser' },
        data: encodeCallbackData({ namespace: 'dep', action: 'creq', targetId: deposit.deposit_id, version: 1 }),
      },
    });
    const depRow = await db
      .prepare('SELECT status FROM deposit_requests WHERE deposit_id = ?1')
      .bind(deposit.deposit_id)
      .first<{ status: string }>();
    expect(depRow!.status).toBe('CANCELLED_BY_CUSTOMER');

    // Withdrawal NEEDS_INFO -> customer clicks wd:rinfo -> rejects OTP -> accepts safe reply -> include_in_ai_context=0
    const wDraft = await withdrawalService.startWithdrawalWizard(env, '7301');
    await withdrawalService.handleAmountInput(env, '7301', '18000');
    await withdrawalService.handleMethodSelection(env, '7301', 'KBZPAY');
    await withdrawalService.handleDestinationInput(env, '7301', 'U Aung - 09451112233');
    const { withdrawal } = await withdrawalService.confirmSubmission(env, {
      customerId: '7301',
      draftToken: wDraft.draftToken,
      correlationId: 'cor_ninfo_w1',
    });

    await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'UNDER_REVIEW',
      expectedVersion: 1,
      correlationId: 'cor_ninfo_rev',
    });
    await withdrawalService.submitSuperAdminDecision(env, {
      adminId: '9001',
      withdrawalId: withdrawal.withdrawal_id,
      newStatus: 'NEEDS_INFO',
      decisionNote: 'Please confirm account holder full name',
      expectedVersion: 2,
      correlationId: 'cor_ninfo_req',
    });

    await postWebhook({
      update_id: 99603,
      callback_query: {
        id: 'cb_wd_rinfo',
        from: { id: 7301, is_bot: false, first_name: 'CancelUser' },
        data: encodeCallbackData({ namespace: 'wd', action: 'rinfo', targetId: withdrawal.withdrawal_id, version: 3 }),
      },
    });

    // Attempt with OTP is rejected and session stays open
    await postWebhook({
      update_id: 99604,
      message: {
        message_id: 604,
        date: 1700000000,
        chat: { id: 7301, type: 'private' },
        from: { id: 7301, is_bot: false, first_name: 'CancelUser' },
        text: 'My OTP is 123456',
      },
    });
    const sessStillOpen = await db
      .prepare(`SELECT wizard_type FROM customer_sessions WHERE customer_id = '7301'`)
      .first<{ wizard_type: string }>();
    expect(sessStillOpen!.wizard_type).toBe('NEEDS_INFO_REPLY');

    // Valid reply clears session and stores message with include_in_ai_context = 0
    await postWebhook({
      update_id: 99605,
      message: {
        message_id: 605,
        date: 1700000000,
        chat: { id: 7301, type: 'private' },
        from: { id: 7301, is_bot: false, first_name: 'CancelUser' },
        text: 'Account holder full name is U Aung Kyaw.',
      },
    });
    const sessCleared = await db
      .prepare(`SELECT * FROM customer_sessions WHERE customer_id = '7301'`)
      .first();
    expect(sessCleared).toBeNull();

    const replyMsg = await db
      .prepare(`SELECT text_content, include_in_ai_context FROM messages WHERE customer_id = '7301' AND update_id = 99605`)
      .first<{ text_content: string; include_in_ai_context: number }>();
    expect(replyMsg!.text_content).toBe('Account holder full name is U Aung Kyaw.');
    expect(replyMsg!.include_in_ai_context).toBe(0);
  });

  // 30. F-04: Strict 32-byte AES Key Validation & Strict Key Version Selection
  it('30. F-04: Rejects placeholder, weak, short, or malformed AES keys and forbids unsafe currentKey fallback on missing previousKey', async () => {
    expect(() => parseAes256KeyBytes('CONFIGURED_IN_CLOUDFLARE_ENV')).toThrow(/placeholder/i);
    expect(() => parseAes256KeyBytes('PENDING_OWNER_CONFIGURATION')).toThrow(/placeholder/i);
    expect(() => parseAes256KeyBytes('short_key')).toThrow();
    expect(() => parseAes256KeyBytes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toThrow(/entropy/i);
    expect(parseAes256KeyBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')).toHaveLength(32);

    const enc = await encryptPayoutDestination('U Test - 09123456789', TEST_AES_KEY_V1, {
      purpose: 'withdrawal_destination',
      customerId: '7401',
      recordToken: 'wdt_f04_1',
      methodCode: 'KBZPAY',
      keyVersion: 1,
    });

    // Missing previousKey when decrypting currentKeyVersion - 1 throws DECRYPTION_KEY_UNAVAILABLE
    await expect(
      decryptPayoutDestination(
        enc.ciphertext,
        enc.iv,
        {
          purpose: 'withdrawal_destination',
          customerId: '7401',
          recordToken: 'wdt_f04_1',
          methodCode: 'KBZPAY',
          keyVersion: 1,
        },
        { currentKey: TEST_AES_KEY_V2, previousKey: undefined, currentKeyVersion: 2 }
      )
    ).rejects.toThrow(/DECRYPTION_KEY_UNAVAILABLE/);

    // Unsupported older keyVersion throws UNSUPPORTED_ENCRYPTION_KEY_VERSION
    await expect(
      decryptPayoutDestination(
        enc.ciphertext,
        enc.iv,
        {
          purpose: 'withdrawal_destination',
          customerId: '7401',
          recordToken: 'wdt_f04_1',
          methodCode: 'KBZPAY',
          keyVersion: 1,
        },
        { currentKey: TEST_AES_KEY_V2, previousKey: TEST_AES_KEY_V1, currentKeyVersion: 3 }
      )
    ).rejects.toThrow(/UNSUPPORTED_ENCRYPTION_KEY_VERSION/);
  });

  // 31. F-05: AI-to-HUMAN Race Produces Zero AI Messages, Zero Outbox Rows, and Zero Queue Signals
  it('31. F-05: Suppresses AI messages, outbox rows, and queue dispatches atomically if customer switches to HUMAN during Gemini latency', async () => {
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();
    const cust = await customerService.ensureActiveCustomer(env, {
      customerId: '7501',
      username: 'raceu',
      firstName: 'RaceUser',
    });

    enqueuedPayloads.length = 0;

    globalThis.fetch = vi.fn(async () => {
      // Simulate concurrent escalation switching customer to HUMAN mode while Gemini call is in flight
      await db
        .prepare(`UPDATE customers SET chat_mode = 'HUMAN' WHERE telegram_user_id = '7501'`)
        .run();

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      replyText: 'Late AI reply that must be suppressed!',
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
      customer: cust,
      telegramMessageId: 7501,
      updateId: 99701,
      text: 'How do bonuses work?',
      correlationId: 'cor_f05_race',
    });

    const aiMessages = await db
      .prepare(`SELECT * FROM messages WHERE customer_id = '7501' AND sender_role = 'MODEL'`)
      .all();
    expect(aiMessages.results).toHaveLength(0);

    const aiOutbox = await db
      .prepare(`SELECT * FROM outbox WHERE target_chat_id = '7501' AND event_type = 'AI_AUTO_REPLY'`)
      .all();
    expect(aiOutbox.results).toHaveLength(0);
    expect(enqueuedPayloads).toHaveLength(0);
  });

  // 32. F-06: Transport Error DELIVERY_UNCERTAIN, Lease-Fenced Completion, Pre-Claim Queue Dedup, & Explicit DLQ Consumer
  it('32. F-06: Marks non-idempotent transport errors DELIVERY_UNCERTAIN, prevents stale lease overwrite, deduplicates queue events, and handles DLQ safely', async () => {
    const nowMs = Date.now();
    await customerService.ensureActiveCustomer(env, {
      customerId: '7601',
      username: 'f06u',
      firstName: 'F06User',
    });

    await db.batch([
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_net_err', 'k_net_err', 'TEST', 'CUSTOMER', '7601', '7601', '7601_a', 1, 'sendMessage', '{"chat_id":"7601","text":"NetErr"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_dedup_qev', 'k_dedup_qev', 'TEST', 'CUSTOMER', '7601', '7601', '7601_b', 1, 'sendMessage', '{"chat_id":"7601","text":"Dedup"}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, lease_owner, lease_token, lease_expires_at, created_at, updated_at)
           VALUES ('obx_lease_race', 'k_lease_race', 'TEST', 'CUSTOMER', '7601', '7601', '7601_c', 1, 'sendMessage', '{"chat_id":"7601","text":"Race"}', 0, 'SENDING', 1, 6, ?1, ?1, 'w1', 'lt_old_token', ?2, ?1, ?1)`
        )
        .bind(nowMs, nowMs - 10000),
    ]);

    // 1. Generic network transport exception (non-timeout TypeError) -> DELIVERY_UNCERTAIN (never auto-retry)
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: connection reset by peer');
    }) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_net_err', 'cor_net', 'qev_net_1', nowMs)).outcome).toBe(
      'DELIVERY_UNCERTAIN'
    );

    // 2. Lease-fenced completion: Cron marks expired SENDING as DELIVERY_UNCERTAIN -> stale worker markSent returns false & does not overwrite
    await scheduledDispatcher.runLeaseRecoveryCron(env, nowMs);
    const raceRow = (await outboxRepository.getById(db, 'obx_lease_race'))!;
    expect(raceRow.status).toBe('DELIVERY_UNCERTAIN');
    const staleOverwrite = await outboxRepository.markSent(db, {
      outbox: raceRow,
      leaseToken: 'lt_old_token',
      telegramMessageId: 999,
      nowMs: nowMs + 100,
    });
    expect(staleOverwrite).toBe(false);
    expect((await outboxRepository.getById(db, 'obx_lease_race'))!.status).toBe('DELIVERY_UNCERTAIN');

    // 3. Pre-claim processed_queue_events guard skips duplicate queue eventId
    let sendCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      sendCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
    }) as typeof globalThis.fetch;
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_dedup_qev', 'cor_dq', 'qev_same_id', nowMs)).outcome).toBe('SENT');
    expect((await outboxConsumer.processSingleOutbox(env, 'obx_dedup_qev', 'cor_dq', 'qev_same_id', nowMs + 1)).outcome).toBe('SKIPPED');
    expect(sendCalls).toBe(1);

    // 4. Explicit DLQ consumer handler records audit, alerts started SUPER_ADMIN, acks without auto-replay
    let acked = false;
    await workerEntry.queue(
      {
        queue: 'vip-outbox-dlq-staging',
        messages: [
          {
            id: 'dlq_msg_1',
            timestamp: new Date(nowMs),
            attempts: 3,
            body: {
              eventId: 'qev_dlq_1',
              outboxId: 'obx_net_err',
              orderingKey: '7601_a',
              sequenceNo: 1,
              correlationId: 'cor_dlq_1',
            },
            ack: () => {
              acked = true;
            },
            retry: () => {
              throw new Error('DLQ must not retry');
            },
          },
        ],
        ackAll: () => {
          acked = true;
        },
        retryAll: () => {
          throw new Error('DLQ must not retry');
        },
      },
      env,
      { waitUntil() {}, passThroughOnException() {}, props: {} }
    );
    expect(acked).toBe(true);
    const dlqAudit = await db
      .prepare(`SELECT action FROM audit_logs WHERE resource_id = 'obx_net_err' AND action = 'OUTBOX_DLQ_EVENT_RECORDED'`)
      .first<{ action: string }>();
    expect(dlqAudit).not.toBeNull();
    const dlqAlert = await db
      .prepare(`SELECT target_chat_id FROM outbox WHERE event_type = 'DLQ_ALERT' AND aggregate_id = 'obx_net_err'`)
      .first<{ target_chat_id: string }>();
    expect(dlqAlert!.target_chat_id).toBe('9001');
  });

  // 33. F-07: Fork-Free Audit Chain Concurrency, Checkpointed Retention, & Terminal Outbox Pruning
  it('33. F-07: Prevents audit chain forks, preserves chain verification across checkpointed retention, and prunes only old terminal outbox rows', async () => {
    const nowMs = Date.now();
    const old400d = nowMs - 400 * 86400000;
    const old60d = nowMs - 60 * 86400000;

    // Seed 2 ancient audit rows (>365d) and 2 recent audit rows concurrently
    await auditRepository.appendImmediate(db, {
      actorId: 'SYS',
      actorRole: 'SYSTEM',
      action: 'OLD_EVT_1',
      resourceType: 'SYSTEM',
      resourceId: 'R1',
      result: 'SUCCESS',
      correlationId: 'cor_old_1',
      nowMs: old400d,
    });
    await auditRepository.appendImmediate(db, {
      actorId: 'SYS',
      actorRole: 'SYSTEM',
      action: 'OLD_EVT_2',
      resourceType: 'SYSTEM',
      resourceId: 'R2',
      result: 'SUCCESS',
      correlationId: 'cor_old_2',
      nowMs: old400d + 1000,
    });

    // Concurrent appends serialize cleanly on UNIQUE(prev_entry_hash) without forking
    await Promise.all([
      auditRepository.appendImmediate(db, {
        actorId: 'SYS',
        actorRole: 'SYSTEM',
        action: 'CONC_EVT_1',
        resourceType: 'SYSTEM',
        resourceId: 'C1',
        result: 'SUCCESS',
        correlationId: 'cor_c1',
        nowMs,
      }),
      auditRepository.appendImmediate(db, {
        actorId: 'SYS',
        actorRole: 'SYSTEM',
        action: 'CONC_EVT_2',
        resourceType: 'SYSTEM',
        resourceId: 'C2',
        result: 'SUCCESS',
        correlationId: 'cor_c2',
        nowMs: nowMs + 1,
      }),
    ]);

    expect((await auditRepository.verifyChainIntegrity(db)).valid).toBe(true);

    // Seed terminal SENT/PERMANENT_FAILURE outbox rows (>30d) + PENDING & DELIVERY_UNCERTAIN rows (>30d)
    await db.batch([
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_old_sent', 'k_os', 'TEST', 'SYSTEM', 'S', '9001', 'o1', 1, 'sendMessage', '{}', 0, 'SENT', 1, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(old60d),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_old_perm', 'k_op', 'TEST', 'SYSTEM', 'S', '9001', 'o2', 1, 'sendMessage', '{}', 0, 'PERMANENT_FAILURE', 1, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(old60d),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_old_unc', 'k_ou', 'TEST', 'SYSTEM', 'S', '9001', 'o3', 1, 'sendMessage', '{}', 0, 'DELIVERY_UNCERTAIN', 1, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(old60d),
      db
        .prepare(
          `INSERT INTO outbox (outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id, target_chat_id, ordering_key, sequence_no, telegram_method, payload_json, is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at)
           VALUES ('obx_old_pend', 'k_opd', 'TEST', 'SYSTEM', 'S', '9001', 'o4', 1, 'sendMessage', '{}', 0, 'PENDING', 0, 6, ?1, ?1, ?1, ?1)`
        )
        .bind(old60d),
    ]);

    const ret = await scheduledDispatcher.runRetentionCron(env, nowMs);
    expect(ret.expiredOutboxDeleted).toBe(2);
    expect(ret.expiredAuditLogsDeleted).toBe(2);
    expect(ret.auditCheckpointId).not.toBeNull();

    // Non-terminal & DELIVERY_UNCERTAIN outbox rows are preserved
    expect(await outboxRepository.getById(db, 'obx_old_sent')).toBeNull();
    expect(await outboxRepository.getById(db, 'obx_old_perm')).toBeNull();
    expect(await outboxRepository.getById(db, 'obx_old_unc')).not.toBeNull();
    expect(await outboxRepository.getById(db, 'obx_old_pend')).not.toBeNull();

    // Chain integrity STILL passes across checkpoint + retained logs!
    const postRetentionChain = await auditRepository.verifyChainIntegrity(db);
    expect(postRetentionChain.valid).toBe(true);
    expect(postRetentionChain.checkpointCount).toBe(1);

    // Checkpoint rows are immutable via SQLite triggers
    await expect(
      db.prepare(`UPDATE audit_retention_checkpoints SET purged_count = 999`).run()
    ).rejects.toThrow(/AUDIT_CHECKPOINTS_IMMUTABLE/i);
    await expect(
      db.prepare(`DELETE FROM audit_retention_checkpoints`).run()
    ).rejects.toThrow(/AUDIT_CHECKPOINTS_IMMUTABLE/i);
  });

  // 34. F-08: BANNED Customers Strictly Blocked Across Messages, /start, Photos, and Callbacks
  it('34. F-08: Immediately blocks BANNED customers across /start, text, photo, and callbacks with zero side effects', async () => {
    const app = createApp();
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();
    await customerService.ensureActiveCustomer(env, {
      customerId: '7801',
      username: 'bannedu',
      firstName: 'BannedUser',
    });
    await db.prepare(`UPDATE customers SET account_status = 'BANNED' WHERE telegram_user_id = '7801'`).run();

    let geminiCalled = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('generativelanguage')) geminiCalled = true;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    const send = (body: Record<string, unknown>) =>
      app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify(body),
        }),
        env
      );

    expect(
      (
        await send({
          update_id: 99801,
          message: {
            message_id: 1,
            date: 1700000000,
            chat: { id: 7801, type: 'private' },
            from: { id: 7801, is_bot: false, first_name: 'BannedUser' },
            text: '/start',
          },
        })
      ).status
    ).toBe(200);

    expect(
      (
        await send({
          update_id: 99802,
          message: {
            message_id: 2,
            date: 1700000000,
            chat: { id: 7801, type: 'private' },
            from: { id: 7801, is_bot: false, first_name: 'BannedUser' },
            text: 'Hello bot answer me',
          },
        })
      ).status
    ).toBe(200);

    expect(
      (
        await send({
          update_id: 99803,
          message: {
            message_id: 3,
            date: 1700000000,
            chat: { id: 7801, type: 'private' },
            from: { id: 7801, is_bot: false, first_name: 'BannedUser' },
            photo: [{ file_id: 'f1', file_unique_id: 'fu_ban', width: 100, height: 100 }],
          },
        })
      ).status
    ).toBe(200);

    expect(
      (
        await send({
          update_id: 99804,
          callback_query: {
            id: 'cb_ban_1',
            from: { id: 7801, is_bot: false, first_name: 'BannedUser' },
            data: encodeCallbackData({ namespace: 'mnu', action: 'open', targetId: 'WITHDRAW' }),
          },
        })
      ).status
    ).toBe(200);

    expect(geminiCalled).toBe(false);
    const outboxCount = (await db.prepare(`SELECT COUNT(*) as c FROM outbox WHERE target_chat_id = '7801'`).first<{ c: number }>())!.c;
    const ticketCount = (await db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE customer_id = '7801'`).first<{ c: number }>())!.c;
    const slipCount = (await db.prepare(`SELECT COUNT(*) as c FROM slip_reviews WHERE customer_id = '7801'`).first<{ c: number }>())!.c;
    expect(outboxCount).toBe(0);
    expect(ticketCount).toBe(0);
    expect(slipCount).toBe(0);
  });

  // 35. F-09 & F-10: HTML Escaping, Bootstrap ai_enabled=0, FAQ Config Snapshot, & Group Migration Handling
  it('35. F-09 & F-10: Escapes all HTML metacharacters, boots with ai_enabled=0 and populated FAQ snapshot, and audits migrate_to_chat_id', async () => {
    expect(escapeHtml(`<a href="x">& 'test'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp; &#39;test&#39;&lt;/a&gt;');

    // Migration 0004 aligned bootstrap config to ai_enabled = 0 and populated config_versions v1 faq_snapshot_json
    const cfg = await db
      .prepare(`SELECT ai_enabled FROM config WHERE config_id = 'active'`)
      .first<{ ai_enabled: number }>();
    expect(cfg!.ai_enabled).toBe(0);

    const v1Snap = await db
      .prepare(`SELECT ai_enabled, faq_snapshot_json FROM config_versions WHERE version_number = 1`)
      .first<{ ai_enabled: number; faq_snapshot_json: string }>();
    expect(v1Snap!.ai_enabled).toBe(0);
    const parsedFaqs = JSON.parse(v1Snap!.faq_snapshot_json) as Array<{ faqId: string }>;
    expect(parsedFaqs.map((f) => f.faqId)).toEqual(
      expect.arrayContaining(['faq_deposit_guide', 'faq_withdrawal_guide'])
    );

    // Toggling AI creates config_versions v2 with non-empty live FAQ snapshot
    await adminService.toggleGlobalAi(env, { adminId: '9001', correlationId: 'cor_f10_snap' });
    const v2Snap = await db
      .prepare(`SELECT faq_snapshot_json FROM config_versions WHERE version_number = 2`)
      .first<{ faq_snapshot_json: string }>();
    const parsedV2Faqs = JSON.parse(v2Snap!.faq_snapshot_json) as Array<{ faqId: string }>;
    expect(parsedV2Faqs.map((f) => f.faqId)).toEqual(
      expect.arrayContaining(['faq_deposit_guide', 'faq_withdrawal_guide'])
    );

    // Telegram group -> supergroup migration webhook handled safely (HTTP 200, audited, SUPER_ADMIN alerted)
    const app = createApp();
    const migRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99901,
          message: {
            message_id: 901,
            date: 1700000000,
            chat: { id: Number(env.TELEGRAM_ADMIN_GROUP_ID), type: 'group' },
            migrate_to_chat_id: -1001122334455,
          },
        }),
      }),
      env
    );
    expect(migRes.status).toBe(200);

    const migAudit = await db
      .prepare(`SELECT action, after_state_json FROM audit_logs WHERE action = 'TELEGRAM_GROUP_MIGRATED_TO_SUPERGROUP'`)
      .first<{ action: string; after_state_json: string }>();
    expect(migAudit).not.toBeNull();
    expect(migAudit!.after_state_json).toContain('-1001122334455');

    const migAlert = await db
      .prepare(`SELECT target_chat_id, payload_json FROM outbox WHERE event_type = 'ADMIN_GROUP_MIGRATION_ALERT'`)
      .first<{ target_chat_id: string; payload_json: string }>();
    expect(migAlert!.target_chat_id).toBe('9001');
    expect(migAlert!.payload_json).toContain('-1001122334455');
  });

  // 36. Phase 6.3 5-State Deployment Readiness Gate, Zero-Root-Binding Isolation, & Explicit targetEnv Enforcement
  it('36. Enforces 5-state fail-closed deployment readiness gate (localConfigValid, stagingResourceReady, secretConfigReady, adminNotificationReady, deploymentAuthorized) and Phase 6.3 staging isolation', () => {
    const wranglerRaw = fs.readFileSync(path.resolve(process.cwd(), 'wrangler.jsonc'), 'utf8');
    const envExampleRaw = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    const currentRepoCfg = JSON.parse(wranglerRaw) as WranglerRootConfig;

    // 1. Current repository config targeting env.staging without external verification:
    //    localConfigValid=true, liveWorkerReplacementRisk=false, resolvedWorkerName='auto-reply-bot-staging'
    const repoCheck = validateWranglerDeploymentConfig(currentRepoCfg, {
      targetEnv: 'staging',
      phaseMode: 'temporary_staging',
      ciOverrideName: EXPECTED_STAGING_WORKER_NAME,
      envExampleContent: envExampleRaw,
    });
    expect(repoCheck.localConfigValid).toBe(true);
    expect(repoCheck.stagingResourceReady).toBe(false);
    expect(repoCheck.secretConfigReady).toBe(false);
    expect(repoCheck.adminNotificationReady).toBe(false);
    expect(repoCheck.deploymentAuthorized).toBe(false);
    expect(repoCheck.readyToDeploy).toBe(false);
    expect(repoCheck.liveWorkerReplacementRisk).toBe(false);
    expect(repoCheck.advisoryScope).toBe('LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK');
    expect(repoCheck.resolvedWorkerName).toBe(EXPECTED_STAGING_WORKER_NAME);
    expect(repoCheck.issues.map((i) => i.code)).not.toContain('PLACEHOLDER_D1_DATABASE_ID');
    expect(repoCheck.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
        'UNVERIFIED_EXTERNAL_SECRETS',
        'UNVERIFIED_ADMIN_NOTIFICATION_ROUTE',
      ])
    );

    // 1b. Placeholder D1 UUID is rejected with PLACEHOLDER_D1_DATABASE_ID
    const placeholderD1Cfg: WranglerRootConfig = structuredClone(currentRepoCfg);
    placeholderD1Cfg.env!.staging.d1_databases![0].database_id = '00000000-0000-0000-0000-000000000000';
    const placeholderD1Res = validateWranglerDeploymentConfig(placeholderD1Cfg, {
      targetEnv: 'staging',
      phaseMode: 'temporary_staging',
      envExampleContent: envExampleRaw,
    });
    expect(placeholderD1Res.stagingResourceReady).toBe(false);
    expect(placeholderD1Res.issues.map((i) => i.code)).toContain('PLACEHOLDER_D1_DATABASE_ID');

    // 2. Empty externalVerification: {} must NOT produce false positives
    const readyCfg: WranglerRootConfig = structuredClone(currentRepoCfg);

    const emptyExternalRes = validateWranglerDeploymentConfig(readyCfg, {
      targetEnv: 'staging',
      phaseMode: 'temporary_staging',
      envExampleContent: envExampleRaw,
      externalVerification: {},
    });
    expect(emptyExternalRes.localConfigValid).toBe(true);
    expect(emptyExternalRes.stagingResourceReady).toBe(false);
    expect(emptyExternalRes.secretConfigReady).toBe(false);
    expect(emptyExternalRes.adminNotificationReady).toBe(false);
    expect(emptyExternalRes.readyToDeploy).toBe(false);

    // 3. Root vs env.staging Worker identity collision (if env.staging.name === "auto-reply-bot") is rejected
    const identityCollisionCfg: WranglerRootConfig = structuredClone(readyCfg);
    identityCollisionCfg.env!.staging.name = 'auto-reply-bot';
    const identityCollisionRes = validateWranglerDeploymentConfig(identityCollisionCfg, {
      targetEnv: 'staging',
    });
    expect(identityCollisionRes.localConfigValid).toBe(false);
    expect(identityCollisionRes.issues.map((i) => i.code)).toContain('ROOT_STAGING_WORKER_IDENTITY_COLLISION');

    // 4. Non-confirmed staging D1 UUID triggers STAGING_RESOURCE_IDENTITY_MISMATCH
    const wrongStagingUuidCfg: WranglerRootConfig = structuredClone(currentRepoCfg);
    wrongStagingUuidCfg.env!.staging.d1_databases![0].database_id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const wrongStagingUuidRes = validateWranglerDeploymentConfig(wrongStagingUuidCfg, {
      targetEnv: 'staging',
    });
    expect(wrongStagingUuidRes.localConfigValid).toBe(false);
    expect(wrongStagingUuidRes.stagingResourceReady).toBe(false);
    expect(wrongStagingUuidRes.issues.map((i) => i.code)).toContain('STAGING_RESOURCE_IDENTITY_MISMATCH');

    // 5. Full external verification on env.staging makes readyToDeploy=true while deploymentAuthorized remains false until explicitOwnerAuthorization=true
    const fullExternalVerification = {
      stagingResources: {
        d1DatabaseProvisioned: true,
        d1MigrationsApplied: true,
        primaryQueueProvisioned: true,
        dlqProvisioned: true,
      },
      secrets: {
        verifiedEncryptedSecretKeys: REQUIRED_SECRET_KEYS,
        historicalPlaintextSecretsCleared: true,
      },
      adminNotification: {
        dashboardVarsConfigured: true,
        adminGroupVerified: true,
        activeStartedSuperAdminVerified: true,
        configuredAdminGroupId: '-100999888777',
        configuredSuperAdminIds: '9001',
      },
    };
    const readyRes = validateWranglerDeploymentConfig(readyCfg, {
      targetEnv: 'staging',
      phaseMode: 'temporary_staging',
      ciOverrideName: EXPECTED_STAGING_WORKER_NAME,
      envExampleContent: envExampleRaw,
      externalVerification: fullExternalVerification,
    });
    expect(readyRes.localConfigValid).toBe(true);
    expect(readyRes.stagingResourceReady).toBe(true);
    expect(readyRes.secretConfigReady).toBe(true);
    expect(readyRes.adminNotificationReady).toBe(true);
    expect(readyRes.liveWorkerReplacementRisk).toBe(false);
    expect(readyRes.deploymentAuthorized).toBe(false);
    expect(readyRes.readyToDeploy).toBe(true);
    expect(readyRes.issues).toHaveLength(0);

    // enforceDeploymentGate blocks deployment when explicitOwnerAuthorization is omitted
    expect(() =>
      enforceDeploymentGate(readyCfg, {
        targetEnv: 'staging',
        phaseMode: 'temporary_staging',
        ciOverrideName: EXPECTED_STAGING_WORKER_NAME,
        envExampleContent: envExampleRaw,
        externalVerification: fullExternalVerification,
      })
    ).toThrow(/DEPLOYMENT_NOT_AUTHORIZED/);

    const authorizedGateRes = enforceDeploymentGate(readyCfg, {
      targetEnv: 'staging',
      phaseMode: 'temporary_staging',
      ciOverrideName: EXPECTED_STAGING_WORKER_NAME,
      envExampleContent: envExampleRaw,
      externalVerification: fullExternalVerification,
      explicitOwnerAuthorization: true,
    });
    expect(authorizedGateRes.deploymentAuthorized).toBe(true);
    expect(authorizedGateRes.readyToDeploy).toBe(true);

    // 6. Rejects missing top-level keep_vars or keep_vars inside named environments
    const badKeepVarsCfg: WranglerRootConfig = structuredClone(readyCfg);
    badKeepVarsCfg.keep_vars = false;
    badKeepVarsCfg.env!.staging.keep_vars = true;
    const keepVarsRes = validateWranglerDeploymentConfig(badKeepVarsCfg, {
      targetEnv: 'staging',
    });
    expect(keepVarsRes.localConfigValid).toBe(false);
    expect(keepVarsRes.readyToDeploy).toBe(false);
    expect(keepVarsRes.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['MISSING_TOP_LEVEL_KEEP_VARS', 'INVALID_NAMED_ENV_KEEP_VARS'])
    );

    // 7. Rejects Dashboard-managed variables, unknown vars, or secrets in Wrangler vars, and detects historical plaintext secret bindings on Dashboard
    const badVarsCfg: WranglerRootConfig = structuredClone(readyCfg);
    badVarsCfg.env!.staging.vars = {
      ...badVarsCfg.env!.staging.vars,
      TELEGRAM_BOT_USERNAME: 'CONFIGURED_IN_CLOUDFLARE_ENV',
      TELEGRAM_BOT_TOKEN: 'leaked_secret_in_vars',
      UNKNOWN_UNCONSUMED_VAR: 'unexpected_value',
    };
    const badVarsRes = validateWranglerDeploymentConfig(badVarsCfg, {
      targetEnv: 'staging',
      dashboardPlaintextBindingKeys: ['GEMINI_API_KEY', 'TELEGRAM_WEBHOOK_SECRET'],
      externalVerification: fullExternalVerification,
    });
    expect(badVarsRes.localConfigValid).toBe(false);
    expect(badVarsRes.secretConfigReady).toBe(false);
    expect(badVarsRes.readyToDeploy).toBe(false);
    expect(badVarsRes.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'DASHBOARD_MANAGED_VAR_IN_WRANGLER_VARS',
        'PLACEHOLDER_VAR_VALUE',
        'SECRET_IN_PLAINTEXT_VARS',
        'UNCONSUMED_OR_UNKNOWN_VAR',
        'HISTORICAL_PLAINTEXT_SECRET_BINDING',
      ])
    );

    // 8. Rejects Staging vs Production D1 or Queue resource collision
    const collisionCfg: WranglerRootConfig = structuredClone(readyCfg);
    collisionCfg.env!.production.d1_databases![0].database_id = CONFIRMED_STAGING_D1_DATABASE_ID;
    collisionCfg.env!.production.queues!.producers![0].queue = CONFIRMED_STAGING_PRIMARY_QUEUE;
    const collisionRes = validateWranglerDeploymentConfig(collisionCfg, {
      targetEnv: 'staging',
    });
    expect(collisionRes.stagingResourceReady).toBe(false);
    expect(collisionRes.issues.map((i) => i.code)).toContain('STAGING_PRODUCTION_RESOURCE_COLLISION');

    // 9. Rejects missing D1 bindings and missing Queue producer / consumers / DLQ
    const missingBindingsCfg: WranglerRootConfig = structuredClone(readyCfg);
    missingBindingsCfg.env!.staging.d1_databases = [];
    missingBindingsCfg.env!.staging.queues = { producers: [], consumers: [] };
    const missingBindingsRes = validateWranglerDeploymentConfig(missingBindingsCfg, {
      targetEnv: 'staging',
    });
    expect(missingBindingsRes.readyToDeploy).toBe(false);
    expect(missingBindingsRes.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['MISSING_D1_BINDING', 'MISSING_QUEUE_PRODUCER'])
    );

    const missingDlqCfg: WranglerRootConfig = structuredClone(readyCfg);
    missingDlqCfg.env!.staging.queues!.consumers = [
      {
        queue: 'vip-outbox-queue-staging',
        max_batch_size: 10,
        max_retries: 3,
        dead_letter_queue: 'vip-outbox-dlq-staging',
      },
    ];
    const missingDlqRes = validateWranglerDeploymentConfig(missingDlqCfg, {
      targetEnv: 'staging',
    });
    expect(missingDlqRes.readyToDeploy).toBe(false);
    expect(missingDlqRes.issues.map((i) => i.code)).toContain('MISSING_DLQ_CONSUMER');

    // 10. Rejects accidental production deployment, root deployment, or inconsistent Worker name
    const badNameCfg: WranglerRootConfig = structuredClone(readyCfg);
    badNameCfg.name = 'vip-gaming-bot';
    const badNameRes = validateWranglerDeploymentConfig(badNameCfg, {
      targetEnv: 'staging',
    });
    expect(badNameRes.readyToDeploy).toBe(false);
    expect(badNameRes.issues.map((i) => i.code)).toContain('INCONSISTENT_WORKER_IDENTITY');

    const accidentalProdEnvRes = validateWranglerDeploymentConfig(readyCfg, {
      targetEnv: 'production',
      phaseMode: 'temporary_staging',
    });
    expect(accidentalProdEnvRes.readyToDeploy).toBe(false);
    expect(accidentalProdEnvRes.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE',
        'PLACEHOLDER_D1_DATABASE_ID',
      ])
    );

    // 11. Rejects invalid environment selection and incompatible WRANGLER_CI_OVERRIDE_NAME
    const invalidEnvRes = validateWranglerDeploymentConfig(readyCfg, {
      targetEnv: 'nonexistent_env',
    });
    expect(invalidEnvRes.readyToDeploy).toBe(false);
    expect(invalidEnvRes.issues.map((i) => i.code)).toContain('INVALID_TARGET_ENVIRONMENT');

    const ciMismatchRes = validateWranglerDeploymentConfig(readyCfg, {
      targetEnv: 'staging',
      ciOverrideName: 'auto-reply-bot',
    });
    expect(ciMismatchRes.readyToDeploy).toBe(false);
    expect(ciMismatchRes.liveWorkerReplacementRisk).toBe(true);
    expect(ciMismatchRes.issues.map((i) => i.code)).toContain('CI_OVERRIDE_NAME_MISMATCH');
  });

  // 37. Phase 3.2/3.3 Runtime Fail-Safe Verification for Missing/Placeholder Secrets and Dashboard Variables
  it('37. Fails closed on missing or placeholder secrets and handles missing Dashboard variables safely with emergency SUPER_ADMIN DM fallback', async () => {
    const app = createApp();

    // 1. Missing or placeholder TELEGRAM_WEBHOOK_SECRET fails closed with 401 even if attacker sends matching placeholder
    for (const badWebhookSecret of ['', '   ', 'CONFIGURED_IN_CLOUDFLARE_ENV', '<TELEGRAM_WEBHOOK_SECRET>', 'PENDING_OWNER_CONFIGURATION']) {
      const envBadWebhook: Env = {
        ...env,
        TELEGRAM_WEBHOOK_SECRET: badWebhookSecret,
        TELEGRAM_WEBHOOK_SECRET_PREVIOUS: undefined,
      };
      const res = await app.fetch(
        new Request('https://bot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': badWebhookSecret || 'any_token',
          },
          body: JSON.stringify({ update_id: 99950 }),
        }),
        envBadWebhook
      );
      expect(res.status).toBe(401);
    }

    // 2. Missing or placeholder WITHDRAWAL_PII_ENCRYPTION_KEY fails closed before storing any withdrawal destination
    await customerService.ensureActiveCustomer(env, {
      customerId: '7901',
      username: 'u7901',
      firstName: 'SafeFailUser',
    });
    await withdrawalService.startWithdrawalWizard(env, '7901');
    await withdrawalService.handleAmountInput(env, '7901', '20000');
    await withdrawalService.handleMethodSelection(env, '7901', 'KBZPAY');

    const envMissingAes: Env = { ...env, WITHDRAWAL_PII_ENCRYPTION_KEY: '' };
    await expect(
      withdrawalService.handleDestinationInput(envMissingAes, '7901', 'U Safe - 09451234567')
    ).rejects.toThrow(/ENCRYPTION_KEY/i);

    // 3. Placeholder GEMINI_API_KEY fails safely into human handover without making external HTTP calls
    await db.prepare(`UPDATE config SET ai_enabled = 1 WHERE config_id = 'active'`).run();
    const custAi = await customerService.ensureActiveCustomer(env, {
      customerId: '7902',
      username: 'u7902',
      firstName: 'AiFailSafe',
    });
    let externalFetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      externalFetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const envPlaceholderGemini: Env = {
      ...env,
      GEMINI_API_KEY: 'CONFIGURED_IN_CLOUDFLARE_ENV',
    };
    await customerService.handleCustomerText(envPlaceholderGemini, {
      customer: custAi,
      telegramMessageId: 7902,
      updateId: 99951,
      text: 'Tell me about VIP bonuses',
      correlationId: 'cor_gem_placeholder',
    });
    expect(externalFetchCalled).toBe(false);
    const custAfterGemFail = await db
      .prepare('SELECT chat_mode FROM customers WHERE telegram_user_id = ?1')
      .bind('7902')
      .first<{ chat_mode: string }>();
    expect(custAfterGemFail!.chat_mode).toBe('HUMAN');

    // 4. Missing Dashboard-managed TELEGRAM_ADMIN_GROUP_ID ("") does not crash deposit submission and triggers EMERGENCY_SUPER_ADMIN_FALLBACK on outbox processing when started SUPER_ADMIN 9001 exists
    const envNoGroup: Env = {
      ...env,
      TELEGRAM_ADMIN_GROUP_ID: '',
      TELEGRAM_BOT_USERNAME: '',
      SUPER_ADMIN_IDS: '',
    };
    const depDraft = await depositService.startDepositWizard(envNoGroup, '7901');
    await depositService.handleAmountInput(envNoGroup, '7901', '30000');
    await depositService.handleMethodSelection(envNoGroup, '7901', 'KBZPAY');
    await depositService.handleReferenceInput(envNoGroup, '7901', 'REF-NOGROUP-01');
    const { deposit } = await depositService.confirmSubmission(envNoGroup, {
      customerId: '7901',
      draftToken: depDraft.draftToken,
      correlationId: 'cor_nogroup_dep',
    });
    expect(deposit.status).toBe('SUBMITTED');

    const groupOutboxRow = await db
      .prepare(
        `SELECT outbox_id, target_chat_id FROM outbox WHERE aggregate_id = ?1 AND event_type = 'GROUP_ALERT'`
      )
      .bind(deposit.deposit_id)
      .first<{ outbox_id: string; target_chat_id: string }>();
    expect(groupOutboxRow).not.toBeNull();
    expect(groupOutboxRow!.target_chat_id).toBe('UNCONFIGURED_ADMIN_GROUP_CHAT');

    const outboxOutcome = await outboxConsumer.processSingleOutbox(
      envNoGroup,
      groupOutboxRow!.outbox_id
    );
    expect(outboxOutcome.outcome).toBe('PERMANENT_FAILURE');
    expect(externalFetchCalled).toBe(false);

    const emergencyFallback = await db
      .prepare(
        `SELECT target_chat_id, payload_json, related_ticket_id FROM outbox WHERE aggregate_id = ?1 AND event_type = 'EMERGENCY_SUPER_ADMIN_FALLBACK'`
      )
      .bind(groupOutboxRow!.outbox_id)
      .first<{ target_chat_id: string; payload_json: string; related_ticket_id: string }>();
    expect(emergencyFallback).not.toBeNull();
    expect(emergencyFallback!.target_chat_id).toBe('9001');
    expect(emergencyFallback!.related_ticket_id).toBe(deposit.ticket_id);
    expect(emergencyFallback!.payload_json).toContain('TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED');
    expect(emergencyFallback!.payload_json).toContain(deposit.deposit_id);
  });

  // 38. Phase 3.3 Cron Trigger Dispatch Verification & Queue Retry Exhaustion -> Permanent Failure Handling
  it('38. Dispatches all 3 cron schedules (* * * * *, */5 * * * *, 0 20 * * *) via workerEntry.scheduled and escalates exhausted retryable failures to permanent failure + fallback', async () => {
    const nowMs = Date.now();
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p);
      },
      passThroughOnException() {},
      props: {},
    };

    // Verify all 3 cron expressions execute cleanly via workerEntry.scheduled
    for (const cronExpr of ['* * * * *', '*/5 * * * *', '0 20 * * *']) {
      await workerEntry.scheduled(
        { cron: cronExpr, scheduledTime: nowMs, noRetry() {} },
        env,
        ctx
      );
    }
    await Promise.all(waitUntilPromises);

    // Test retry exhaustion: outbox row at attempt_count = 5 (with max_attempts = 6) receives HTTP 502 from Telegram
    // When claimed, attempt_count becomes 6 === max_attempts -> must transition to PERMANENT_FAILURE, record OUTBOX_PERMANENT_FAILURE, and trigger EMERGENCY_SUPER_ADMIN_FALLBACK
    await db
      .prepare(
        `INSERT INTO outbox (
           outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id,
           target_chat_id, ordering_key, sequence_no, telegram_method, payload_json,
           is_idempotent_method, status, attempt_count, max_attempts, available_at, next_dispatch_at, created_at, updated_at
         ) VALUES (
           'obx_exhaust_502', 'k_exhaust_502', 'GROUP_ALERT', 'DEPOSIT', 'DEP-EXHAUST-01',
           ?1, 'grp_exhaust', 1, 'sendMessage', ?2,
           0, 'RETRYABLE_FAILURE', 5, 6, ?3, ?3, ?3, ?3
         )`
      )
      .bind(
        env.TELEGRAM_ADMIN_GROUP_ID,
        JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_GROUP_ID, text: '<b>Exhausted Group Alert</b>' }),
        nowMs
      )
      .run();

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), { status: 502 })
    ) as typeof globalThis.fetch;

    const exhaustRes = await outboxConsumer.processSingleOutbox(env, 'obx_exhaust_502', 'cor_exhaust', 'qev_exhaust_6', nowMs);
    expect(exhaustRes.outcome).toBe('PERMANENT_FAILURE');

    const exhaustedRow = await outboxRepository.getById(db, 'obx_exhaust_502');
    expect(exhaustedRow!.status).toBe('PERMANENT_FAILURE');
    expect(exhaustedRow!.last_error).toContain('MAX_ATTEMPTS_EXHAUSTED');

    const exhaustAudit = await db
      .prepare(`SELECT action FROM audit_logs WHERE resource_id = 'obx_exhaust_502' AND action = 'OUTBOX_PERMANENT_FAILURE'`)
      .first<{ action: string }>();
    expect(exhaustAudit).not.toBeNull();

    const exhaustFallback = await db
      .prepare(`SELECT target_chat_id, payload_json FROM outbox WHERE aggregate_id = 'obx_exhaust_502' AND event_type = 'EMERGENCY_SUPER_ADMIN_FALLBACK'`)
      .first<{ target_chat_id: string; payload_json: string }>();
    expect(exhaustFallback).not.toBeNull();
    expect(exhaustFallback!.target_chat_id).toBe('9001');
    expect(exhaustFallback!.payload_json).toContain('MAX_ATTEMPTS_EXHAUSTED');
  });

  // 39. Phase 3.3 Method-Specific Telegram API Payload Validation
  it('39. Validates method-specific Telegram payload requirements across sendMessage, sendPhoto, sendDocument, editMessageText, answerCallbackQuery, getMe, and getChatMember', async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { status: 200 });
    }) as typeof globalThis.fetch;

    // 1. answerCallbackQuery succeeds WITHOUT chat_id, fails without callback_query_id
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery', {
        callback_query_id: 'cb_valid_123',
        text: 'Claimed!',
      })
    ).resolves.toEqual({ messageId: 101, rawResult: { message_id: 101 } });
    expect(fetchCount).toBe(1);

    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery', {
        text: 'Missing callback_query_id',
      })
    ).rejects.toThrow(/TELEGRAM_CALLBACK_QUERY_ID_REQUIRED/);
    expect(fetchCount).toBe(1);

    // 2. getMe succeeds WITHOUT chat_id
    await expect(telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'getMe', {})).resolves.toEqual({
      messageId: 101,
      rawResult: { message_id: 101 },
    });
    expect(fetchCount).toBe(2);

    // 3. sendMessage requires chat_id and non-empty text
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
        chat_id: '9001',
        text: '   ',
      })
    ).rejects.toThrow(/TELEGRAM_MESSAGE_TEXT_REQUIRED/);
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
        chat_id: '<TELEGRAM_ADMIN_GROUP_ID>',
        text: 'Hello',
      })
    ).rejects.toThrow(/TELEGRAM_TARGET_CHAT_ID_NOT_CONFIGURED/);

    // 4. sendPhoto requires chat_id and photo
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendPhoto', {
        chat_id: '9001',
      })
    ).rejects.toThrow(/TELEGRAM_PHOTO_REQUIRED/);
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendPhoto', {
        chat_id: '9001',
        photo: 'AgACAgUAAxkBAAI',
      })
    ).resolves.toBeDefined();

    // 5. sendDocument requires chat_id and document
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendDocument', {
        chat_id: '9001',
      })
    ).rejects.toThrow(/TELEGRAM_DOCUMENT_REQUIRED/);
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'sendDocument', {
        chat_id: '9001',
        document: 'BQACAgUAAxkBAAI',
      })
    ).resolves.toBeDefined();

    // 6. editMessageText supports inline_message_id WITHOUT chat_id, or chat_id + message_id
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'editMessageText', {
        inline_message_id: 'inline_msg_99',
        text: 'Updated inline text',
      })
    ).resolves.toBeDefined();
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'editMessageText', {
        chat_id: '9001',
        text: 'Missing message_id',
      })
    ).rejects.toThrow(/TELEGRAM_MESSAGE_ID_REQUIRED/);
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'editMessageText', {
        chat_id: '9001',
        message_id: 42,
        text: 'Updated chat message',
      })
    ).resolves.toBeDefined();

    // 7. getChatMember requires chat_id and user_id
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'getChatMember', {
        chat_id: '-100999888777',
      })
    ).rejects.toThrow(/TELEGRAM_USER_ID_REQUIRED/);
    await expect(
      telegramService.callApi(env.TELEGRAM_BOT_TOKEN, 'getChatMember', {
        chat_id: '-100999888777',
        user_id: 9001,
      })
    ).resolves.toBeDefined();
  });

  // 40. Phase 3.3 Admin Notification Hold, Automatic Recovery (on Super Admin /start or Group Config), & Zero PII Leakage Matrix
  it('40. Holds unreachable admin alerts when no SUPER_ADMIN has started the bot, recovers automatically on /start or group ID config, reopens if all fallback DMs fail, and never leaks PII', async () => {
    const app = createApp();
    // Mark all admins as unstarted (has_started_bot = 0) and leave TELEGRAM_ADMIN_GROUP_ID placeholder/unconfigured
    await db.prepare(`UPDATE admins SET has_started_bot = 0`).run();

    const envUnconfigured: Env = {
      ...env,
      TELEGRAM_ADMIN_GROUP_ID: '<TELEGRAM_ADMIN_GROUP_ID>',
      SUPER_ADMIN_IDS: '9001',
    };

    await customerService.ensureActiveCustomer(envUnconfigured, {
      customerId: '8101',
      username: 'u8101',
      firstName: 'HoldRecoverUser',
    });

    // Submit withdrawal with sensitive destination PII ("U Secret Holder - 09987654321")
    const wdDraft = await withdrawalService.startWithdrawalWizard(envUnconfigured, '8101');
    await withdrawalService.handleAmountInput(envUnconfigured, '8101', '50000');
    await withdrawalService.handleMethodSelection(envUnconfigured, '8101', 'KBZPAY');
    await withdrawalService.handleDestinationInput(envUnconfigured, '8101', 'U Secret Holder - 09987654321');
    const { withdrawal } = await withdrawalService.confirmSubmission(envUnconfigured, {
      customerId: '8101',
      draftToken: wdDraft.draftToken,
      correlationId: 'cor_hold_wd',
    });

    const groupOutbox = await db
      .prepare(`SELECT * FROM outbox WHERE aggregate_id = ?1 AND event_type = 'GROUP_ALERT'`)
      .bind(withdrawal.withdrawal_id)
      .first<{ outbox_id: string; target_chat_id: string; payload_json: string; status: string }>();
    expect(groupOutbox).not.toBeNull();
    expect(groupOutbox!.target_chat_id).toBe('UNCONFIGURED_ADMIN_GROUP_CHAT');
    // Group outbox payload must NEVER contain raw payout destination PII
    expect(groupOutbox!.payload_json).not.toContain('09987654321');
    expect(groupOutbox!.payload_json).not.toContain('U Secret Holder');

    // 1. Processing outbox when TELEGRAM_ADMIN_GROUP_ID is unconfigured AND zero started SUPER_ADMINs exist:
    //    MUST NOT mark SENT or abandon in PERMANENT_FAILURE -> holds in RETRYABLE_FAILURE and records ADMIN_NOTIFICATION_HELD_NO_REACHABLE_ADMIN
    const holdRes = await outboxConsumer.processSingleOutbox(envUnconfigured, groupOutbox!.outbox_id);
    expect(holdRes.outcome).toBe('RETRYABLE_FAILURE');

    const heldRow = await outboxRepository.getById(db, groupOutbox!.outbox_id);
    expect(heldRow!.status).toBe('RETRYABLE_FAILURE');
    expect(heldRow!.last_error).toContain('ADMIN_NOTIFICATION_CHANNEL_UNAVAILABLE');

    const holdAudit = await db
      .prepare(`SELECT action FROM audit_logs WHERE resource_id = ?1 AND action = 'ADMIN_NOTIFICATION_HELD_NO_REACHABLE_ADMIN'`)
      .bind(groupOutbox!.outbox_id)
      .first<{ action: string }>();
    expect(holdAudit).not.toBeNull();

    // 2. Super Admin 9001 sends /start in private chat -> marks has_started_bot=1 and automatically releases held admin notification!
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 })
    ) as typeof globalThis.fetch;

    const startRes = await app.fetch(
      new Request('https://bot.example/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 99981,
          message: {
            message_id: 981,
            date: 1700000000,
            chat: { id: 9001, type: 'private' },
            from: { id: 9001, is_bot: false, first_name: 'Super' },
            text: '/start',
          },
        }),
      }),
      envUnconfigured
    );
    expect(startRes.status).toBe(200);

    // Now process the released group alert -> creates EMERGENCY_SUPER_ADMIN_FALLBACK DM to started Super Admin 9001
    const afterStartRes = await outboxConsumer.processSingleOutbox(envUnconfigured, groupOutbox!.outbox_id);
    expect(afterStartRes.outcome).toBe('PERMANENT_FAILURE');

    const fallbackRow = await db
      .prepare(`SELECT * FROM outbox WHERE aggregate_id = ?1 AND event_type = 'EMERGENCY_SUPER_ADMIN_FALLBACK'`)
      .bind(groupOutbox!.outbox_id)
      .first<{ outbox_id: string; target_chat_id: string; payload_json: string }>();
    expect(fallbackRow).not.toBeNull();
    expect(fallbackRow!.target_chat_id).toBe('9001');
    // Fallback DM must NEVER contain raw payout destination PII
    expect(fallbackRow!.payload_json).not.toContain('09987654321');
    expect(fallbackRow!.payload_json).not.toContain('U Secret Holder');

    // 3. If ALL Super Admin fallback DMs fail permanently (e.g., Super Admin blocked the bot -> 403 Forbidden),
    //    the original group alert row is reopened to RETRYABLE_FAILURE so it is never lost!
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
    ) as typeof globalThis.fetch;

    const fbFailRes = await outboxConsumer.processSingleOutbox(envUnconfigured, fallbackRow!.outbox_id);
    expect(fbFailRes.outcome).toBe('PERMANENT_FAILURE');

    const reopenedGroupRow = await outboxRepository.getById(db, groupOutbox!.outbox_id);
    expect(reopenedGroupRow!.status).toBe('RETRYABLE_FAILURE');
    expect(reopenedGroupRow!.last_error).toContain('ALL_SUPER_ADMIN_FALLBACK_DMS_FAILED');

    // 4. When TELEGRAM_ADMIN_GROUP_ID is subsequently configured in Dashboard, lease recovery cron heals UNCONFIGURED_ADMIN_GROUP_CHAT -> real group chat ID and delivers!
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 })
    ) as typeof globalThis.fetch;

    await scheduledDispatcher.runLeaseRecoveryCron(env, Date.now());
    const healedRow = await outboxRepository.getById(db, groupOutbox!.outbox_id);
    expect(healedRow!.target_chat_id).toBe(env.TELEGRAM_ADMIN_GROUP_ID);

    const deliveredRes = await outboxConsumer.processSingleOutbox(env, groupOutbox!.outbox_id);
    expect(deliveredRes.outcome).toBe('SENT');
  });

  // 41. Phase 6.3 Comprehensive Pre-Deploy Guard, Zero-Root-Binding Isolation, & CLI Enforcement Verification
  it('41. Enforces all 13 Phase 6.3 staging isolation invariants across deploymentGuard, scripts/predeploy-check.ts, wrangler.jsonc, and package.json', () => {
    const wranglerRaw = fs.readFileSync(path.resolve(process.cwd(), 'wrangler.jsonc'), 'utf8');
    const pkgRaw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    const currentRepoCfg = JSON.parse(wranglerRaw) as WranglerRootConfig;
    const pkgJson = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };

    // 1. Existing Worker identity preservation & Staging/Production Worker identities
    expect(currentRepoCfg.name).toBe(EXPECTED_ROOT_WORKER_NAME);
    expect(currentRepoCfg.keep_vars).toBe(true);
    expect(currentRepoCfg.env?.staging?.name).toBeUndefined();
    expect(currentRepoCfg.env?.production?.name).toBeUndefined();

    const stagingRes = validateWranglerDeploymentConfig(currentRepoCfg, { targetEnv: 'staging' });
    expect(stagingRes.resolvedWorkerName).toBe(EXPECTED_STAGING_WORKER_NAME);
    expect(stagingRes.liveWorkerReplacementRisk).toBe(false);

    const prodRes = validateWranglerDeploymentConfig(currentRepoCfg, { targetEnv: 'production' });
    expect(prodRes.resolvedWorkerName).toBe(EXPECTED_PRODUCTION_WORKER_NAME);

    // 2. Exact Staging D1 UUID & exclusive Staging Queue bindings
    const stgD1 = currentRepoCfg.env?.staging?.d1_databases?.[0];
    expect(stgD1).toEqual({
      binding: 'DB',
      database_name: CONFIRMED_STAGING_D1_DATABASE_NAME,
      database_id: CONFIRMED_STAGING_D1_DATABASE_ID,
      migrations_dir: 'migrations',
    });
    expect(currentRepoCfg.env?.staging?.queues?.producers).toEqual([
      {
        binding: 'OUTBOX_QUEUE',
        queue: CONFIRMED_STAGING_PRIMARY_QUEUE,
      },
    ]);
    expect(currentRepoCfg.env?.staging?.queues?.consumers?.map((c) => c.queue)).toEqual([
      CONFIRMED_STAGING_PRIMARY_QUEUE,
      CONFIRMED_STAGING_DLQ,
    ]);

    // 3. Root resource prohibition (root cannot declare D1, Queues, vars, or crons)
    const rootWithBindingsCfg: WranglerRootConfig = structuredClone(currentRepoCfg);
    rootWithBindingsCfg.d1_databases = [
      {
        binding: 'DB',
        database_name: CONFIRMED_STAGING_D1_DATABASE_NAME,
        database_id: CONFIRMED_STAGING_D1_DATABASE_ID,
        migrations_dir: 'migrations',
      },
    ];
    rootWithBindingsCfg.queues = {
      producers: [{ binding: 'OUTBOX_QUEUE', queue: CONFIRMED_STAGING_PRIMARY_QUEUE }],
      consumers: [{ queue: CONFIRMED_STAGING_PRIMARY_QUEUE, dead_letter_queue: CONFIRMED_STAGING_DLQ }],
    };
    const rootBindingsRes = validateWranglerDeploymentConfig(rootWithBindingsCfg, {
      targetEnv: 'staging',
    });
    expect(rootBindingsRes.localConfigValid).toBe(false);
    expect(rootBindingsRes.stagingResourceReady).toBe(false);
    expect(rootBindingsRes.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'ROOT_RESOURCE_BINDINGS_FORBIDDEN',
        'STAGING_PRODUCTION_RESOURCE_COLLISION',
      ])
    );

    // 4. Staging/production D1 isolation & 5. Staging/production Queue isolation & 12. Production Queue consumer ownership
    const prodD1 = currentRepoCfg.env?.production?.d1_databases?.[0];
    expect(prodD1?.database_name).toBe('vip-gaming-d1-prod');
    expect(prodD1?.database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(prodD1?.database_name).not.toBe(stgD1?.database_name);
    expect(prodD1?.database_id).not.toBe(stgD1?.database_id);

    const prodConsumerQueues = currentRepoCfg.env?.production?.queues?.consumers?.map((c) => c.queue) ?? [];
    expect(prodConsumerQueues).toEqual(['vip-outbox-queue-prod', 'vip-outbox-dlq-prod']);
    for (const q of prodConsumerQueues) {
      expect(currentRepoCfg.env?.staging?.queues?.consumers?.map((c) => c.queue)).not.toContain(q);
      expect(currentRepoCfg.queues?.consumers?.map((c) => c.queue) ?? []).not.toContain(q);
    }

    // 6. Root deployment rejection
    const rootDeployRes = validateWranglerDeploymentConfig(currentRepoCfg, {
      targetEnv: 'top-level',
    });
    expect(rootDeployRes.localConfigValid).toBe(false);
    expect(rootDeployRes.readyToDeploy).toBe(false);
    expect(rootDeployRes.liveWorkerReplacementRisk).toBe(true);
    expect(rootDeployRes.issues.map((i) => i.code)).toContain('ROOT_DEPLOYMENT_FORBIDDEN');

    const rootCliRes = runPredeployCheck({
      argv: ['--target=top-level'],
      env: {},
    });
    expect(rootCliRes.allowed).toBe(false);
    expect(rootCliRes.exitCode).toBe(1);
    expect(rootCliRes.blockingIssueCodes).toContain('ROOT_DEPLOYMENT_FORBIDDEN');

    // 7. Production deployment rejection
    const prodCliRes = runPredeployCheck({
      argv: ['--target=production'],
      env: {},
    });
    expect(prodCliRes.allowed).toBe(false);
    expect(prodCliRes.exitCode).toBe(1);
    expect(prodCliRes.blockingIssueCodes).toEqual(
      expect.arrayContaining([
        'PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE',
        'PLACEHOLDER_D1_DATABASE_ID',
      ])
    );

    // 8. Missing explicit targetEnv fails closed with MISSING_EXPLICIT_TARGET_ENV
    const missingTargetRes = validateWranglerDeploymentConfig(currentRepoCfg);
    expect(missingTargetRes.localConfigValid).toBe(false);
    expect(missingTargetRes.readyToDeploy).toBe(false);
    expect(missingTargetRes.issues.map((i) => i.code)).toEqual(['MISSING_EXPLICIT_TARGET_ENV']);

    const missingTargetCliRes = runPredeployCheck({
      argv: [],
      env: {},
    });
    expect(missingTargetCliRes.allowed).toBe(false);
    expect(missingTargetCliRes.exitCode).toBe(1);
    expect(missingTargetCliRes.blockingIssueCodes).toContain('MISSING_EXPLICIT_TARGET_ENV');

    // 9. CI override mismatch fails closed before Wrangler can override the Worker name to auto-reply-bot
    const ciMismatchCliRes = runPredeployCheck({
      argv: ['--target=staging'],
      env: { WRANGLER_CI_OVERRIDE_NAME: 'auto-reply-bot' },
    });
    expect(ciMismatchCliRes.allowed).toBe(false);
    expect(ciMismatchCliRes.exitCode).toBe(1);
    expect(ciMismatchCliRes.blockingIssueCodes).toContain('CI_OVERRIDE_NAME_MISMATCH');

    // 10. Direct deployment guard hook verification & 11. Approved staging pre-deploy guard execution
    const missingHookCfg: WranglerRootConfig = structuredClone(currentRepoCfg);
    delete missingHookCfg.env!.staging.build;
    const missingHookRes = validateWranglerDeploymentConfig(missingHookCfg, {
      targetEnv: 'staging',
    });
    expect(missingHookRes.localConfigValid).toBe(false);
    expect(missingHookRes.issues.map((i) => i.code)).toContain('MISSING_PREDEPLOY_BUILD_COMMAND_HOOK');

    const stagingCliPassNoCi = runPredeployCheck({
      argv: ['--target=staging'],
      env: {},
    });
    expect(stagingCliPassNoCi.allowed).toBe(true);
    expect(stagingCliPassNoCi.exitCode).toBe(0);
    expect(stagingCliPassNoCi.guardResult.resolvedWorkerName).toBe(EXPECTED_STAGING_WORKER_NAME);

    const stagingCliPassMatchingCi = runPredeployCheck({
      argv: ['--target=staging'],
      env: { WRANGLER_CI_OVERRIDE_NAME: EXPECTED_STAGING_WORKER_NAME },
    });
    expect(stagingCliPassMatchingCi.allowed).toBe(true);
    expect(stagingCliPassMatchingCi.exitCode).toBe(0);

    // Verify package.json scripts: predeploy:staging, deploy:staging (--env staging --no-x-provision), deploy:staging:dry-run, and NO generic deploy script
    expect(pkgJson.scripts?.['predeploy:staging']).toBe('tsx scripts/predeploy-check.ts --target=staging');
    expect(pkgJson.scripts?.['deploy:staging']).toBe('wrangler deploy --env staging --no-x-provision');
    expect(pkgJson.scripts?.['deploy:staging:dry-run']).toContain('wrangler deploy --env staging --no-x-provision --dry-run');
    expect(pkgJson.scripts).not.toHaveProperty('deploy');
  });
});




