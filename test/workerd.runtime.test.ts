import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Miniflare } from 'miniflare';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const WORKER_BUNDLE = path.resolve(process.cwd(), 'dist-worker/index.js');

const TEST_AES_KEY_V1 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

/**
 * Splits a SQL migration file into executable top-level statements while
 * preserving single-quoted string literals and CREATE TRIGGER ... BEGIN ... END; blocks.
 */
function splitSqlStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inTriggerBlock = false;

  for (let i = 0; i < withoutLineComments.length; i++) {
    const ch = withoutLineComments[i];
    const next = withoutLineComments[i + 1];

    if (ch === "'" && !inSingleQuote) {
      inSingleQuote = true;
      current += ch;
      continue;
    }
    if (ch === "'" && inSingleQuote) {
      if (next === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingleQuote = false;
      current += ch;
      continue;
    }

    current += ch;

    if (!inSingleQuote) {
      if (!inTriggerBlock && /\bCREATE\s+TRIGGER\b/i.test(current) && /\bBEGIN\b/i.test(current)) {
        inTriggerBlock = true;
      }

      if (ch === ';') {
        if (inTriggerBlock) {
          if (/\bEND\s*;$/i.test(current.trim())) {
            inTriggerBlock = false;
            const trimmed = current.trim();
            if (trimmed) statements.push(trimmed);
            current = '';
          }
        } else {
          const trimmed = current.trim();
          if (trimmed) statements.push(trimmed);
          current = '';
        }
      }
    }
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

describe('Cloudflare workerd + Miniflare D1 Runtime Verification Suite (F-12)', () => {
  let mf: Miniflare;

  beforeAll(async () => {
    // Build the exact production ESM Worker bundle before loading it into real workerd
    execSync('npm run build:worker', { cwd: process.cwd(), stdio: 'pipe' });
    expect(fs.existsSync(WORKER_BUNDLE)).toBe(true);

    mf = new Miniflare({
      modules: true,
      scriptPath: WORKER_BUNDLE,
      compatibilityDate: '2025-03-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'vip-gaming-d1-test' },
      bindings: {
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
        TELEGRAM_WEBHOOK_SECRET: 'workerd_secret_token_v2',
        TELEGRAM_WEBHOOK_SECRET_PREVIOUS: 'workerd_secret_token_v1',
        GEMINI_API_KEY: 'TEST_GEMINI_KEY_NOT_REAL',
        WITHDRAWAL_PII_ENCRYPTION_KEY: TEST_AES_KEY_V1,
      },
      queueProducers: {
        OUTBOX_QUEUE: { queueName: 'vip-outbox-queue-staging' },
      },
    });

    // Apply all 5 SQL migrations sequentially against real Miniflare D1
    const db = await mf.getD1Database('DB');
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.length).toBe(5);

    for (const file of files) {
      const rawSql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const statements = splitSqlStatements(rawSql);
      for (const stmt of statements) {
        await db.prepare(stmt).run();
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  it('W1. Applies all 5 migrations cleanly in real workerd D1 with 18 tables, F-03/F-07 columns, ai_enabled=0, and populated FAQ snapshot', async () => {
    const db = await mf.getD1Database('DB');
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .all<{ name: string }>();
    const names = tables.results.map((r) => r.name);

    for (const required of [
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
      'audit_retention_checkpoints',
    ]) {
      expect(names).toContain(required);
    }

    const cfg = await db
      .prepare(`SELECT ai_enabled FROM config WHERE config_id = 'active'`)
      .first<{ ai_enabled: number }>();
    expect(cfg!.ai_enabled).toBe(0);

    const v1 = await db
      .prepare(`SELECT ai_enabled, faq_snapshot_json FROM config_versions WHERE version_number = 1`)
      .first<{ ai_enabled: number; faq_snapshot_json: string }>();
    expect(v1!.ai_enabled).toBe(0);
    const parsedFaqs = JSON.parse(v1!.faq_snapshot_json) as Array<{ faqId: string }>;
    expect(parsedFaqs.map((f) => f.faqId)).toEqual(
      expect.arrayContaining(['faq_deposit_guide', 'faq_withdrawal_guide'])
    );

    // Verify migration 0005 columns exist in real workerd D1
    const csCols = await db.prepare('PRAGMA table_info(customer_sessions)').all<{ name: string }>();
    expect(csCols.results.map((c) => c.name)).toContain('target_ticket_id');
    const auditCols = await db.prepare('PRAGMA table_info(audit_logs)').all<{ name: string }>();
    expect(auditCols.results.map((c) => c.name)).toContain('hash_version');
    const cpCols = await db.prepare('PRAGMA table_info(audit_retention_checkpoints)').all<{ name: string }>();
    expect(cpCols.results.map((c) => c.name)).toContain('hash_version');
  });

  it('W2. Serves /healthz, enforces webhook secret auth & 413 body limit, processes /start, and deduplicates updates in real workerd', async () => {
    const health = await mf.dispatchFetch('https://worker.local/healthz');
    expect(health.status).toBe(200);
    const hJson = (await health.json()) as Record<string, unknown>;
    expect(hJson.ok).toBe(true);
    expect(hJson.bot_username).toBe('vip_gaming_support_bot');

    const unauth = await mf.dispatchFetch('https://worker.local/webhook', {
      method: 'POST',
      body: '{}',
    });
    expect(unauth.status).toBe(401);

    const oversized = await mf.dispatchFetch('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'workerd_secret_token_v2',
      },
      body: JSON.stringify({ update_id: 50000, pad: 'A'.repeat(270 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const payload = JSON.stringify({
      update_id: 50001,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: 88001, type: 'private' },
        from: { id: 88001, is_bot: false, first_name: 'WorkerdUser' },
        text: '/start',
      },
    });

    const first = await mf.dispatchFetch('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'workerd_secret_token_v2',
      },
      body: payload,
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('PROCESSED');

    const dup = await mf.dispatchFetch('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'workerd_secret_token_v2',
      },
      body: payload,
    });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { status: string }).status).toBe('DUPLICATE_IGNORED');

    const db = await mf.getD1Database('DB');
    const cust = await db
      .prepare(`SELECT telegram_user_id FROM customers WHERE telegram_user_id = '88001'`)
      .first<{ telegram_user_id: string }>();
    expect(cust!.telegram_user_id).toBe('88001');

    // Verify bootstrap SUPER_ADMIN (9001) was created with has_started_bot = 0
    const superAdmin = await db
      .prepare(`SELECT role, has_started_bot FROM admins WHERE telegram_user_id = '9001'`)
      .first<{ role: string; has_started_bot: number }>();
    expect(superAdmin!.role).toBe('SUPER_ADMIN');
    expect(superAdmin!.has_started_bot).toBe(0);
  });

  it('W3. Enforces UNIQUE(prev_entry_hash) and checkpoint immutability triggers in real workerd D1', async () => {
    const db = await mf.getD1Database('DB');
    const nowMs = Date.now();

    await db
      .prepare(
        `INSERT INTO audit_logs (
          audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
          correlation_id, prev_entry_hash, entry_hash, created_at
        ) VALUES ('aud_w_1', 'SYS', 'SYSTEM', 'TEST_1', 'SYSTEM', 'S1', 'SUCCESS', 'c1', 'GENESIS', 'HASH_1', ?1)`
      )
      .bind(nowMs)
      .run();

    // Fork attempt with duplicate prev_entry_hash 'GENESIS' must fail in D1
    await expect(
      db
        .prepare(
          `INSERT INTO audit_logs (
            audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
            correlation_id, prev_entry_hash, entry_hash, created_at
          ) VALUES ('aud_w_fork', 'SYS', 'SYSTEM', 'FORK', 'SYSTEM', 'S2', 'SUCCESS', 'c2', 'GENESIS', 'HASH_FORK', ?1)`
        )
        .bind(nowMs + 1)
        .run()
    ).rejects.toThrow(/UNIQUE/i);

    // Checkpoint immutability triggers must block UPDATE and DELETE in real D1
    await db
      .prepare(
        `INSERT INTO audit_retention_checkpoints (
          checkpoint_id, prev_checkpoint_hash, anchor_audit_id, anchor_entry_hash,
          anchor_created_at, purged_count, checkpoint_hash, created_at
        ) VALUES ('chk_w_1', 'GENESIS_CHECKPOINT', 'aud_w_1', 'HASH_1', ?1, 1, 'CHK_HASH_1', ?1)`
      )
      .bind(nowMs)
      .run();

    await expect(
      db.prepare(`UPDATE audit_retention_checkpoints SET purged_count = 99 WHERE checkpoint_id = 'chk_w_1'`).run()
    ).rejects.toThrow(/AUDIT_CHECKPOINTS_IMMUTABLE/i);

    await expect(
      db.prepare(`DELETE FROM audit_retention_checkpoints WHERE checkpoint_id = 'chk_w_1'`).run()
    ).rejects.toThrow(/AUDIT_CHECKPOINTS_IMMUTABLE/i);
  });

  it('W4. Executes all 3 scheduled cron triggers cleanly inside real workerd runtime', async () => {
    const worker = await mf.getWorker();
    const res1 = await worker.scheduled({ cron: '* * * * *' });
    expect(res1.outcome).toBe('ok');

    const res2 = await worker.scheduled({ cron: '*/5 * * * *' });
    expect(res2.outcome).toBe('ok');

    const res3 = await worker.scheduled({ cron: '0 20 * * *' });
    expect(res3.outcome).toBe('ok');

    const db = await mf.getD1Database('DB');
    const retAudit = await db
      .prepare(`SELECT action, hash_version FROM audit_logs WHERE action = 'RETENTION_CLEANUP'`)
      .first<{ action: string; hash_version: number }>();
    expect(retAudit).not.toBeNull();
    expect(retAudit!.hash_version).toBe(2);
  });
});
