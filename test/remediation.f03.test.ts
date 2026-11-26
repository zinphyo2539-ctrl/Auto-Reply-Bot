import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { SqliteD1Adapter } from '../src/worker/testing/sqliteD1Adapter';
import type { Env, OutboxQueuePayload, QueueProducer } from './testHelpers';
import { customerService } from '../src/worker/services/customerService';
import { depositService } from '../src/worker/services/depositService';
import { withdrawalService } from '../src/worker/services/withdrawalService';
import { depositRepository } from '../src/worker/repositories/depositRepository';
import { withdrawalRepository } from '../src/worker/repositories/withdrawalRepository';
import { AuthorizationError, ConflictError, NotFoundError } from '../src/worker/lib/errors';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const TEST_AES_KEY_V1 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

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

async function seedCustomersAndAdmin(db: SqliteD1Adapter, env: Env, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (
         telegram_user_id, role, is_active, has_started_bot, permissions_json,
         display_name, version, created_at, updated_at
       ) VALUES ('9001', 'SUPER_ADMIN', 1, 1, '["ticket.view","deposit.review","withdrawal.review"]', 'Super Admin', 1, ?1, ?1)`
    )
    .bind(nowMs)
    .run();

  await customerService.ensureActiveCustomer(env, {
    customerId: '7001',
    username: 'cust_one',
    firstName: 'CustOne',
  });
  await customerService.ensureActiveCustomer(env, {
    customerId: '7002',
    username: 'cust_two',
    firstName: 'CustTwo',
  });
}

async function insertTicket(
  db: SqliteD1Adapter,
  params: {
    ticketId: string;
    customerId: string;
    status: 'OPEN' | 'ASSIGNED' | 'RESOLVED';
    assignedAdminId?: string | null;
    createdAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO support_tickets (
         ticket_id, customer_id, ticket_type, status, assigned_admin_id,
         version, created_at, updated_at
       ) VALUES (?1, ?2, 'GENERAL_SUPPORT', ?3, ?4, 1, ?5, ?5)`
    )
    .bind(
      params.ticketId,
      params.customerId,
      params.status,
      params.assignedAdminId ?? null,
      params.createdAt
    )
    .run();
}

async function runDepositWizardToConfirm(
  env: Env,
  customerId: string,
  nowMs: number,
  options?: { ticketId?: string | null }
): Promise<string> {
  const started = await depositService.startDepositWizard(env, customerId, nowMs, options);
  await depositService.handleAmountInput(env, customerId, '50000', nowMs + 10);
  await depositService.handleMethodSelection(env, customerId, 'KBZPAY', nowMs + 20);
  const summary = await depositService.handleReferenceInput(env, customerId, 'REF-F03-12345', nowMs + 30);
  expect(summary.draftToken).toBe(started.draftToken);
  return started.draftToken;
}

async function runWithdrawalWizardToConfirm(
  env: Env,
  customerId: string,
  nowMs: number,
  options?: { ticketId?: string | null }
): Promise<string> {
  const started = await withdrawalService.startWithdrawalWizard(env, customerId, nowMs, options);
  await withdrawalService.handleAmountInput(env, customerId, '40000', nowMs + 10);
  await withdrawalService.handleMethodSelection(env, customerId, 'KBZPAY', nowMs + 20);
  const summary = await withdrawalService.handleDestinationInput(
    env,
    customerId,
    'U Mg Mg - 09123456789',
    nowMs + 30
  );
  expect(summary.draftToken).toBe(started.draftToken);
  return started.draftToken;
}

describe('F-03 Remediation — Deterministic Deposit & Withdrawal Ticket Association', () => {
  let db: SqliteD1Adapter;
  let env: Env;
  const baseNow = 1_750_000_000_000;

  beforeEach(async () => {
    db = new SqliteD1Adapter(':memory:');
    db.applyMigrations(MIGRATIONS_DIR);
    env = createTestEnv(db).env;
    await seedCustomersAndAdmin(db, env, baseNow);
  });

  afterEach(() => {
    db.close();
  });

  it('F03-1. Binds single valid OPEN or ASSIGNED ticket deterministically for both Deposit and Withdrawal', async () => {
    await insertTicket(db, {
      ticketId: 'tkt_open_single',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow,
    });

    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 100);
    const depRes = await depositService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: depToken,
      correlationId: 'cor_f03_1_dep',
      nowMs: baseNow + 200,
    });
    expect(depRes.createdNew).toBe(true);
    expect(depRes.deposit.ticket_id).toBe('tkt_open_single');

    // Transition ticket to ASSIGNED and verify Withdrawal also binds deterministically
    await db
      .prepare(`UPDATE support_tickets SET status = 'ASSIGNED', assigned_admin_id = '9001' WHERE ticket_id = 'tkt_open_single'`)
      .run();

    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 300);
    const wdRes = await withdrawalService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: wdToken,
      correlationId: 'cor_f03_1_wd',
      nowMs: baseNow + 400,
    });
    expect(wdRes.createdNew).toBe(true);
    expect(wdRes.withdrawal.ticket_id).toBe('tkt_open_single');
  });

  it('F03-2. Multi-OPEN tickets: explicit ticketId binds ONLY intended ticket; implicit fails closed (Deposit & Withdrawal)', async () => {
    // Drop production single-active-ticket index in this isolated test DB to exercise multi-active scenarios
    await db.prepare('DROP INDEX idx_unique_active_ticket_per_customer').run();

    await insertTicket(db, {
      ticketId: 'tkt_open_a',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow + 10,
    });
    await insertTicket(db, {
      ticketId: 'tkt_open_b',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow + 20,
    });

    // Implicit start fails closed because >1 active ticket exists
    await expect(depositService.startDepositWizard(env, '7001', baseNow + 100)).rejects.toThrow(ConflictError);
    await expect(withdrawalService.startWithdrawalWizard(env, '7001', baseNow + 100)).rejects.toThrow(ConflictError);

    // Explicit selection of older ticket tkt_open_a binds strictly to tkt_open_a (not tkt_open_b)
    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 200, {
      ticketId: 'tkt_open_a',
    });
    const depRes = await depositService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: depToken,
      ticketId: 'tkt_open_a',
      correlationId: 'cor_f03_2_dep',
      nowMs: baseNow + 300,
    });
    expect(depRes.deposit.ticket_id).toBe('tkt_open_a');

    // Explicit selection of tkt_open_b for withdrawal binds strictly to tkt_open_b
    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 400, {
      ticketId: 'tkt_open_b',
    });
    const wdRes = await withdrawalService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: wdToken,
      ticketId: 'tkt_open_b',
      correlationId: 'cor_f03_2_wd',
      nowMs: baseNow + 500,
    });
    expect(wdRes.withdrawal.ticket_id).toBe('tkt_open_b');
  });

  it('F03-3. Multi-ASSIGNED and mixed OPEN+ASSIGNED tickets: binds exact intended ticket and rejects ticketId swap', async () => {
    await db.prepare('DROP INDEX idx_unique_active_ticket_per_customer').run();

    await insertTicket(db, {
      ticketId: 'tkt_assigned_1',
      customerId: '7001',
      status: 'ASSIGNED',
      assignedAdminId: '9001',
      createdAt: baseNow + 10,
    });
    await insertTicket(db, {
      ticketId: 'tkt_assigned_2',
      customerId: '7001',
      status: 'ASSIGNED',
      assignedAdminId: '9001',
      createdAt: baseNow + 20,
    });
    await insertTicket(db, {
      ticketId: 'tkt_open_3',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow + 30,
    });

    // Deposit bound to tkt_assigned_1: attempting to confirm with tkt_open_3 must fail closed
    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 100, {
      ticketId: 'tkt_assigned_1',
    });
    await expect(
      depositService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_open_3',
        correlationId: 'cor_f03_3_dep_swap',
        nowMs: baseNow + 150,
      })
    ).rejects.toThrow(ConflictError);

    // Confirming with intended tkt_assigned_1 succeeds and associates ONLY with tkt_assigned_1
    const depRes = await depositService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: depToken,
      ticketId: 'tkt_assigned_1',
      correlationId: 'cor_f03_3_dep_ok',
      nowMs: baseNow + 200,
    });
    expect(depRes.deposit.ticket_id).toBe('tkt_assigned_1');

    // Withdrawal bound to tkt_assigned_2: attempting swap to tkt_assigned_1 must fail closed
    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 300, {
      ticketId: 'tkt_assigned_2',
    });
    await expect(
      withdrawalService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: wdToken,
        ticketId: 'tkt_assigned_1',
        correlationId: 'cor_f03_3_wd_swap',
        nowMs: baseNow + 350,
      })
    ).rejects.toThrow(ConflictError);

    const wdRes = await withdrawalService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: wdToken,
      ticketId: 'tkt_assigned_2',
      correlationId: 'cor_f03_3_wd_ok',
      nowMs: baseNow + 400,
    });
    expect(wdRes.withdrawal.ticket_id).toBe('tkt_assigned_2');
  });

  it('F03-4. Fails closed when explicit ticket belongs to another customer, does not exist, or is RESOLVED', async () => {
    await insertTicket(db, {
      ticketId: 'tkt_foreign_7002',
      customerId: '7002',
      status: 'OPEN',
      createdAt: baseNow,
    });
    await insertTicket(db, {
      ticketId: 'tkt_closed_7001',
      customerId: '7001',
      status: 'RESOLVED',
      createdAt: baseNow,
    });

    // Foreign ticket
    await expect(
      depositService.startDepositWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_foreign_7002' })
    ).rejects.toThrow(AuthorizationError);
    await expect(
      withdrawalService.startWithdrawalWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_foreign_7002' })
    ).rejects.toThrow(AuthorizationError);

    // Missing ticket
    await expect(
      depositService.startDepositWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_does_not_exist' })
    ).rejects.toThrow(NotFoundError);
    await expect(
      withdrawalService.startWithdrawalWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_does_not_exist' })
    ).rejects.toThrow(NotFoundError);

    // Closed (RESOLVED) ticket
    await expect(
      depositService.startDepositWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_closed_7001' })
    ).rejects.toThrow(ConflictError);
    await expect(
      withdrawalService.startWithdrawalWizard(env, '7001', baseNow + 100, { ticketId: 'tkt_closed_7001' })
    ).rejects.toThrow(ConflictError);

    // Also verify zero requests were created
    const depCount = await db.prepare('SELECT COUNT(*) AS c FROM deposit_requests').first<{ c: number }>();
    const wdCount = await db.prepare('SELECT COUNT(*) AS c FROM withdrawal_requests').first<{ c: number }>();
    expect(depCount!.c).toBe(0);
    expect(wdCount!.c).toBe(0);
  });

  it('F03-5. Fails closed if ticket transitions to RESOLVED between wizard init and confirmation (zero fallback/substitution)', async () => {
    await insertTicket(db, {
      ticketId: 'tkt_ephemeral_dep',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow,
    });

    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 100, {
      ticketId: 'tkt_ephemeral_dep',
    });

    // Ticket gets RESOLVED before customer confirms, and even a brand-new OPEN ticket is opened
    await db
      .prepare(`UPDATE support_tickets SET status = 'RESOLVED' WHERE ticket_id = 'tkt_ephemeral_dep'`)
      .run();
    await insertTicket(db, {
      ticketId: 'tkt_other_open',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow + 150,
    });

    // Must NOT silently substitute tkt_other_open or create a fallback ticket!
    await expect(
      depositService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: depToken,
        correlationId: 'cor_f03_5_dep',
        nowMs: baseNow + 200,
      })
    ).rejects.toThrow(ConflictError);

    const depCount = await db.prepare('SELECT COUNT(*) AS c FROM deposit_requests').first<{ c: number }>();
    expect(depCount!.c).toBe(0);

    // Same check for Withdrawal
    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 300, {
      ticketId: 'tkt_other_open',
    });
    await db
      .prepare(`UPDATE support_tickets SET status = 'RESOLVED' WHERE ticket_id = 'tkt_other_open'`)
      .run();
    await insertTicket(db, {
      ticketId: 'tkt_third_open',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow + 350,
    });

    await expect(
      withdrawalService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: wdToken,
        correlationId: 'cor_f03_5_wd',
        nowMs: baseNow + 400,
      })
    ).rejects.toThrow(ConflictError);

    const wdCount = await db.prepare('SELECT COUNT(*) AS c FROM withdrawal_requests').first<{ c: number }>();
    expect(wdCount!.c).toBe(0);
  });

  it('F03-6. Atomic SQL repository gate rejects foreign/closed/mismatched tickets even if called directly', async () => {
    await insertTicket(db, {
      ticketId: 'tkt_7001_valid',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow,
    });
    await insertTicket(db, {
      ticketId: 'tkt_7002_foreign',
      customerId: '7002',
      status: 'OPEN',
      createdAt: baseNow,
    });
    await insertTicket(db, {
      ticketId: 'tkt_7001_closed',
      customerId: '7001',
      status: 'RESOLVED',
      createdAt: baseNow,
    });

    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 100, {
      ticketId: 'tkt_7001_valid',
    });

    // Direct SQL attempt with foreign ticket -> 0 rows inserted
    const foreignDep = await depositRepository
      .prepareAtomicCreateFromSession(db, {
        depositId: 'DEP-SQL-FOREIGN',
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_7002_foreign',
        currency: 'MMK',
        mutationToken: 'mut_1',
        nowMs: baseNow + 200,
      })
      .first();
    expect(foreignDep).toBeNull();

    // Direct SQL attempt with closed ticket -> 0 rows inserted
    const closedDep = await depositRepository
      .prepareAtomicCreateFromSession(db, {
        depositId: 'DEP-SQL-CLOSED',
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_7001_closed',
        currency: 'MMK',
        mutationToken: 'mut_2',
        nowMs: baseNow + 200,
      })
      .first();
    expect(closedDep).toBeNull();

    // Direct SQL attempt for withdrawal with foreign & closed tickets -> 0 rows inserted
    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 300, {
      ticketId: 'tkt_7001_valid',
    });

    const foreignWd = await withdrawalRepository
      .prepareAtomicCreateFromSession(db, {
        withdrawalId: 'WD-SQL-FOREIGN',
        customerId: '7001',
        draftToken: wdToken,
        ticketId: 'tkt_7002_foreign',
        currency: 'MMK',
        mutationToken: 'mut_3',
        nowMs: baseNow + 400,
      })
      .first();
    expect(foreignWd).toBeNull();

    const closedWd = await withdrawalRepository
      .prepareAtomicCreateFromSession(db, {
        withdrawalId: 'WD-SQL-CLOSED',
        customerId: '7001',
        draftToken: wdToken,
        ticketId: 'tkt_7001_closed',
        currency: 'MMK',
        mutationToken: 'mut_4',
        nowMs: baseNow + 400,
      })
      .first();
    expect(closedWd).toBeNull();
  });

  it('F03-7. Duplicate and concurrent confirmations preserve exact intended ticket_id with zero duplicate rows', async () => {
    await db.prepare('DROP INDEX idx_unique_active_ticket_per_customer').run();

    await insertTicket(db, {
      ticketId: 'tkt_target_1',
      customerId: '7001',
      status: 'OPEN',
      createdAt: baseNow,
    });
    await insertTicket(db, {
      ticketId: 'tkt_distractor_2',
      customerId: '7001',
      status: 'ASSIGNED',
      assignedAdminId: '9001',
      createdAt: baseNow + 10,
    });

    // Deposit concurrent confirmations with same draftToken
    const depToken = await runDepositWizardToConfirm(env, '7001', baseNow + 100, {
      ticketId: 'tkt_target_1',
    });

    const [depA, depB] = await Promise.all([
      depositService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_target_1',
        correlationId: 'cor_f03_7_dep_a',
        nowMs: baseNow + 200,
      }),
      depositService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_target_1',
        correlationId: 'cor_f03_7_dep_b',
        nowMs: baseNow + 200,
      }),
    ]);

    expect([depA.createdNew, depB.createdNew].filter(Boolean).length).toBe(1);
    expect(depA.deposit.deposit_id).toBe(depB.deposit.deposit_id);
    expect(depA.deposit.ticket_id).toBe('tkt_target_1');
    expect(depB.deposit.ticket_id).toBe('tkt_target_1');

    // Sequential duplicate confirmation is also idempotent and rejects ticket mismatch
    const depDup = await depositService.confirmSubmission(env, {
      customerId: '7001',
      draftToken: depToken,
      ticketId: 'tkt_target_1',
      correlationId: 'cor_f03_7_dep_c',
      nowMs: baseNow + 210,
    });
    expect(depDup.createdNew).toBe(false);
    expect(depDup.deposit.ticket_id).toBe('tkt_target_1');

    await expect(
      depositService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: depToken,
        ticketId: 'tkt_distractor_2',
        correlationId: 'cor_f03_7_dep_mismatch',
        nowMs: baseNow + 215,
      })
    ).rejects.toThrow(ConflictError);

    const depCount = await db.prepare('SELECT COUNT(*) AS c FROM deposit_requests').first<{ c: number }>();
    expect(depCount!.c).toBe(1);

    // Withdrawal concurrent confirmations with same draftToken
    const wdToken = await runWithdrawalWizardToConfirm(env, '7001', baseNow + 300, {
      ticketId: 'tkt_distractor_2',
    });

    const [wdA, wdB] = await Promise.all([
      withdrawalService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: wdToken,
        ticketId: 'tkt_distractor_2',
        correlationId: 'cor_f03_7_wd_a',
        nowMs: baseNow + 400,
      }),
      withdrawalService.confirmSubmission(env, {
        customerId: '7001',
        draftToken: wdToken,
        ticketId: 'tkt_distractor_2',
        correlationId: 'cor_f03_7_wd_b',
        nowMs: baseNow + 400,
      }),
    ]);

    expect([wdA.createdNew, wdB.createdNew].filter(Boolean).length).toBe(1);
    expect(wdA.withdrawal.withdrawal_id).toBe(wdB.withdrawal.withdrawal_id);
    expect(wdA.withdrawal.ticket_id).toBe('tkt_distractor_2');
    expect(wdB.withdrawal.ticket_id).toBe('tkt_distractor_2');

    const wdCount = await db.prepare('SELECT COUNT(*) AS c FROM withdrawal_requests').first<{ c: number }>();
    expect(wdCount!.c).toBe(1);
  });
});
