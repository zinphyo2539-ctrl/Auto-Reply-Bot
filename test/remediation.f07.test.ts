import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteD1Adapter } from '../src/worker/testing/sqliteD1Adapter';
import { auditRepository } from '../src/worker/repositories/auditRepository';
import {
  CURRENT_AUDIT_HASH_VERSION,
  CURRENT_CHECKPOINT_HASH_VERSION,
  computeAuditCheckpointHash,
  computeAuditEntryHash,
  canonicalizeNullableJsonField,
} from '../src/worker/lib/crypto';
import type { AuditLogRow, AuditRetentionCheckpointRow } from '../src/worker/types/domain';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

async function dropAuditImmutabilityTriggersForTamperTest(db: SqliteD1Adapter): Promise<void> {
  await db.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_update').run();
  await db.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
  await db.prepare('DROP TRIGGER IF EXISTS trg_audit_checkpoints_no_update').run();
  await db.prepare('DROP TRIGGER IF EXISTS trg_audit_checkpoints_no_delete').run();
}

describe('F-07 Remediation — Full-Field Versioned Canonical Audit & Checkpoint Hashing', () => {
  let db: SqliteD1Adapter;
  const baseNow = 1_750_000_000_000;

  beforeEach(() => {
    db = new SqliteD1Adapter(':memory:');
    db.applyMigrations(MIGRATIONS_DIR);
  });

  afterEach(() => {
    db.close();
  });

  it('F07-1. Detects tampering on EVERY audited field including before_state_json, after_state_json, reason, and source_update_id', async () => {
    await auditRepository.appendImmediate(db, {
      auditId: 'aud_f07_target',
      actorId: '9001',
      actorRole: 'SUPER_ADMIN',
      action: 'DEPOSIT_APPROVED_MANUAL_CREDITED',
      resourceType: 'DEPOSIT',
      resourceId: 'DEP-2026-001',
      result: 'SUCCESS',
      beforeState: { status: 'PENDING_ADMIN_REVIEW', amount: 50000 },
      afterState: { status: 'APPROVED_MANUAL_CREDITED', evidence: 'KBZ-REF-991' },
      reason: 'Verified manual bank receipt',
      sourceUpdateId: 777001,
      correlationId: 'cor_f07_1',
      nowMs: baseNow,
    });

    const row = await db
      .prepare(`SELECT * FROM audit_logs WHERE audit_id = 'aud_f07_target'`)
      .first<AuditLogRow>();
    expect(row).not.toBeNull();
    expect(row!.hash_version).toBe(CURRENT_AUDIT_HASH_VERSION);

    const baselineVerify = await auditRepository.verifyChainIntegrity(db);
    expect(baselineVerify.valid).toBe(true);
    expect(baselineVerify.checkedCount).toBe(1);

    await dropAuditImmutabilityTriggersForTamperTest(db);

    const tamperCases: Array<{
      field: string;
      sql: string;
      bindVal: unknown;
      expectedReason: string;
    }> = [
      {
        field: 'before_state_json',
        sql: `UPDATE audit_logs SET before_state_json = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: JSON.stringify({ status: 'PENDING_ADMIN_REVIEW', amount: 999999 }),
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'after_state_json',
        sql: `UPDATE audit_logs SET after_state_json = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: JSON.stringify({ status: 'APPROVED_MANUAL_CREDITED', evidence: 'FORGED-REF' }),
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'reason',
        sql: `UPDATE audit_logs SET reason = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'Tampered justification',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'source_update_id',
        sql: `UPDATE audit_logs SET source_update_id = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 777002,
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'actor_id',
        sql: `UPDATE audit_logs SET actor_id = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: '9002',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'actor_role',
        sql: `UPDATE audit_logs SET actor_role = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'SUPPORT_AGENT',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'action',
        sql: `UPDATE audit_logs SET action = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'DEPOSIT_REJECTED',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'resource_type',
        sql: `UPDATE audit_logs SET resource_type = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'WITHDRAWAL',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'resource_id',
        sql: `UPDATE audit_logs SET resource_id = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'DEP-2026-999',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'result',
        sql: `UPDATE audit_logs SET result = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'DENIED',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'correlation_id',
        sql: `UPDATE audit_logs SET correlation_id = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'cor_f07_forged',
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'created_at',
        sql: `UPDATE audit_logs SET created_at = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: baseNow + 1,
        expectedReason: 'AUDIT_ENTRY_HASH_TAMPERED',
      },
      {
        field: 'prev_entry_hash',
        sql: `UPDATE audit_logs SET prev_entry_hash = ?1 WHERE audit_id = 'aud_f07_target'`,
        bindVal: 'FORGED_PREV_HASH',
        expectedReason: 'AUDIT_PREV_HASH_MISMATCH',
      },
    ];

    for (const tc of tamperCases) {
      // Restore clean row before each individual field mutation
      await db
        .prepare(
          `UPDATE audit_logs
           SET actor_id = ?1, actor_role = ?2, action = ?3, resource_type = ?4, resource_id = ?5,
               result = ?6, before_state_json = ?7, after_state_json = ?8, reason = ?9,
               correlation_id = ?10, source_update_id = ?11, prev_entry_hash = ?12,
               entry_hash = ?13, hash_version = ?14, created_at = ?15
           WHERE audit_id = 'aud_f07_target'`
        )
        .bind(
          row!.actor_id,
          row!.actor_role,
          row!.action,
          row!.resource_type,
          row!.resource_id,
          row!.result,
          row!.before_state_json,
          row!.after_state_json,
          row!.reason,
          row!.correlation_id,
          row!.source_update_id,
          row!.prev_entry_hash,
          row!.entry_hash,
          row!.hash_version,
          row!.created_at
        )
        .run();

      await db.prepare(tc.sql).bind(tc.bindVal).run();
      const check = await auditRepository.verifyChainIntegrity(db);
      expect(check.valid, `Tampering ${tc.field} must be detected`).toBe(false);
      expect(check.brokenAuditId).toBe('aud_f07_target');
      expect(check.reason).toBe(tc.expectedReason);
    }
  });

  it('F07-2. Eliminates delimiter ambiguity (|, quotes, backslashes, control chars, Unicode, null vs empty string)', async () => {
    const base = {
      prevHash: 'GENESIS',
      auditId: 'aud_delim',
      actorId: '9001',
      actorRole: 'SUPER_ADMIN',
      resourceType: 'SYSTEM',
      result: 'SUCCESS',
      createdAt: baseNow,
      correlationId: 'cor_delim',
      hashVersion: 2,
    };

    // Classic pipe-delimiter boundary shift collision in v1 MUST NOT collide in v2
    const hA = await computeAuditEntryHash({
      ...base,
      action: 'A|B',
      resourceId: 'C',
    });
    const hB = await computeAuditEntryHash({
      ...base,
      action: 'A',
      resourceId: 'B|C',
    });
    expect(hA).not.toBe(hB);

    // null vs empty string reason must produce distinct hashes
    const hNullReason = await computeAuditEntryHash({
      ...base,
      action: 'TEST',
      resourceId: 'R1',
      reason: null,
    });
    const hEmptyReason = await computeAuditEntryHash({
      ...base,
      action: 'TEST',
      resourceId: 'R1',
      reason: '',
    });
    expect(hNullReason).not.toBe(hEmptyReason);

    // Unicode (Myanmar + emoji), quotes, backslashes, newlines, tabs, and NUL bytes round-trip cleanly
    const weirdReason = 'ငွေသွင်း စစ်ဆေးပြီး ✅ | "quoted" \\ backslash \n newline \r\t\u0000 end';
    await auditRepository.appendImmediate(db, {
      auditId: 'aud_unicode_ctrl',
      actorId: '9001',
      actorRole: 'SUPER_ADMIN',
      action: 'UNICODE|EDGE\\TEST',
      resourceType: 'CONFIG',
      resourceId: 'cfg|1\n2',
      result: 'SUCCESS',
      beforeState: { my: 'မြန်မာ 🇲🇲', pipe: 'a|b', ctrl: 'line1\nline2\u0000' },
      afterState: { quote: '"hello\\world"', empty: '' },
      reason: weirdReason,
      sourceUpdateId: 0,
      correlationId: 'cor|x\ty',
      nowMs: baseNow + 10,
    });

    const verify = await auditRepository.verifyChainIntegrity(db);
    expect(verify.valid).toBe(true);
    expect(verify.checkedCount).toBe(1);
  });

  it('F07-3. Canonical JSON key-order invariance and strict raw non-JSON differentiation', async () => {
    const common = {
      prevHash: 'GENESIS',
      auditId: 'aud_json',
      actorId: '9001',
      actorRole: 'SUPER_ADMIN',
      action: 'CONFIG_UPDATED',
      resourceType: 'CONFIG',
      resourceId: 'active',
      result: 'SUCCESS',
      reason: null,
      sourceUpdateId: null,
      createdAt: baseNow,
      correlationId: 'cor_json',
      hashVersion: 2,
    };

    // Semantically equivalent JSON with different key ordering hashes identically
    const hOrder1 = await computeAuditEntryHash({
      ...common,
      afterStateJson: '{"b":1,"a":{"z":true,"m":[3,2,1]}}',
    });
    const hOrder2 = await computeAuditEntryHash({
      ...common,
      afterStateJson: '{"a":{"m":[3,2,1],"z":true},"b":1}',
    });
    expect(hOrder1).toBe(hOrder2);

    // Array order IS semantically significant -> different hash
    const hDiffArray = await computeAuditEntryHash({
      ...common,
      afterStateJson: '{"a":{"m":[1,2,3],"z":true},"b":1}',
    });
    expect(hOrder1).not.toBe(hDiffArray);

    // null vs "" (invalid JSON -> R) vs "null" (valid JSON null -> J) vs invalid raw JSON are all distinct
    expect(canonicalizeNullableJsonField('after_state_json', null)).toEqual({
      name: 'after_state_json',
      type: 'N',
      value: '',
    });
    expect(canonicalizeNullableJsonField('after_state_json', '')).toEqual({
      name: 'after_state_json',
      type: 'R',
      value: '',
    });
    expect(canonicalizeNullableJsonField('after_state_json', 'null')).toEqual({
      name: 'after_state_json',
      type: 'J',
      value: 'null',
    });
    expect(canonicalizeNullableJsonField('after_state_json', '{bad_json')).toEqual({
      name: 'after_state_json',
      type: 'R',
      value: '{bad_json',
    });

    const hNull = await computeAuditEntryHash({ ...common, afterStateJson: null });
    const hEmptyRaw = await computeAuditEntryHash({ ...common, afterStateJson: '' });
    const hJsonNull = await computeAuditEntryHash({ ...common, afterStateJson: 'null' });
    const hBadRaw1 = await computeAuditEntryHash({ ...common, afterStateJson: '{bad_json_1' });
    const hBadRaw2 = await computeAuditEntryHash({ ...common, afterStateJson: '{bad_json_2' });

    const unique = new Set([hNull, hEmptyRaw, hJsonNull, hBadRaw1, hBadRaw2]);
    expect(unique.size).toBe(5);
  });

  it('F07-4. Fails closed on unknown/unsupported hash_version for both audit_logs and audit_retention_checkpoints', async () => {
    await expect(
      computeAuditEntryHash({
        prevHash: 'GENESIS',
        auditId: 'aud_bad_v',
        actorId: 'SYS',
        actorRole: 'SYSTEM',
        action: 'TEST',
        resourceType: 'SYSTEM',
        resourceId: 'SYS',
        result: 'SUCCESS',
        createdAt: baseNow,
        correlationId: 'cor',
        hashVersion: 3,
      })
    ).rejects.toThrow(/UNSUPPORTED_AUDIT_HASH_VERSION/);

    await expect(
      computeAuditCheckpointHash({
        prevCheckpointHash: 'GENESIS_CHECKPOINT',
        checkpointId: 'acp_bad_v',
        anchorAuditId: 'aud_1',
        anchorEntryHash: 'h1',
        anchorCreatedAt: baseNow,
        purgedCount: 1,
        createdAt: baseNow,
        hashVersion: 99,
      })
    ).rejects.toThrow(/UNSUPPORTED_CHECKPOINT_HASH_VERSION/);

    // Insert valid entry, then tamper its hash_version to 3 (unsupported)
    await auditRepository.appendImmediate(db, {
      auditId: 'aud_ver_test',
      actorId: 'SYS',
      actorRole: 'SYSTEM',
      action: 'TEST',
      resourceType: 'SYSTEM',
      resourceId: 'SYS',
      result: 'SUCCESS',
      correlationId: 'cor_ver',
      nowMs: baseNow - 400 * 86400000,
    });

    await dropAuditImmutabilityTriggersForTamperTest(db);
    await db.prepare(`UPDATE audit_logs SET hash_version = 3 WHERE audit_id = 'aud_ver_test'`).run();

    const checkEntry = await auditRepository.verifyChainIntegrity(db);
    expect(checkEntry.valid).toBe(false);
    expect(checkEntry.brokenAuditId).toBe('aud_ver_test');
    expect(checkEntry.reason).toBe('UNSUPPORTED_AUDIT_HASH_VERSION');

    // Retention purge must also fail closed on unsupported hash_version
    await expect(
      auditRepository.purgeExpiredWithCheckpoint(db, baseNow - 301 * 86400000, baseNow, 50)
    ).rejects.toThrow(/UNSUPPORTED_HASH_VERSION/);

    // Restore audit_logs to v2, purge to create checkpoint, then set checkpoint hash_version = 99
    await db.prepare(`UPDATE audit_logs SET hash_version = 2 WHERE audit_id = 'aud_ver_test'`).run();
    const purgeRes = await auditRepository.purgeExpiredWithCheckpoint(
      db,
      baseNow - 301 * 86400000,
      baseNow,
      50
    );
    expect(purgeRes.purgedCount).toBe(1);
    expect(purgeRes.checkpointId).not.toBeNull();

    await db
      .prepare(`UPDATE audit_retention_checkpoints SET hash_version = 99 WHERE checkpoint_id = ?1`)
      .bind(purgeRes.checkpointId)
      .run();

    const checkCp = await auditRepository.verifyChainIntegrity(db);
    expect(checkCp.valid).toBe(false);
    expect(checkCp.brokenCheckpointId).toBe(purgeRes.checkpointId);
    expect(checkCp.reason).toBe('UNSUPPORTED_CHECKPOINT_HASH_VERSION');
  });

  it('F07-5. Detects deleted entries, reordered entries, and checkpoint tampering across retention boundary', async () => {
    const oldBase = baseNow - 400 * 86400000;
    for (let i = 1; i <= 4; i++) {
      await auditRepository.appendImmediate(db, {
        auditId: `aud_seq_${i}`,
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: `STEP_${i}`,
        resourceType: 'SYSTEM',
        resourceId: `R${i}`,
        result: 'SUCCESS',
        afterState: { step: i },
        correlationId: `cor_seq_${i}`,
        nowMs: i <= 2 ? oldBase + i : baseNow + i,
      });
    }

    // Purge first 2 expired entries creating a v2 checkpoint
    const purgeRes = await auditRepository.purgeExpiredWithCheckpoint(
      db,
      baseNow - 301 * 86400000,
      baseNow + 100,
      50
    );
    expect(purgeRes.purgedCount).toBe(2);
    expect(purgeRes.checkpointId).not.toBeNull();

    const cpRow = await db
      .prepare('SELECT * FROM audit_retention_checkpoints WHERE checkpoint_id = ?1')
      .bind(purgeRes.checkpointId)
      .first<AuditRetentionCheckpointRow>();
    expect(cpRow!.hash_version).toBe(CURRENT_CHECKPOINT_HASH_VERSION);

    // Append another entry post-checkpoint and confirm entire chain verifies
    await auditRepository.appendImmediate(db, {
      auditId: 'aud_seq_5',
      actorId: 'SYSTEM',
      actorRole: 'SYSTEM',
      action: 'STEP_5',
      resourceType: 'SYSTEM',
      resourceId: 'R5',
      result: 'SUCCESS',
      correlationId: 'cor_seq_5',
      nowMs: baseNow + 200,
    });
    const okVerify = await auditRepository.verifyChainIntegrity(db);
    expect(okVerify.valid).toBe(true);
    expect(okVerify.checkpointCount).toBe(1);
    expect(okVerify.checkedCount).toBe(3);

    await dropAuditImmutabilityTriggersForTamperTest(db);

    // Checkpoint tampering (purged_count)
    await db
      .prepare(`UPDATE audit_retention_checkpoints SET purged_count = 999 WHERE checkpoint_id = ?1`)
      .bind(purgeRes.checkpointId)
      .run();
    const tamperedCp = await auditRepository.verifyChainIntegrity(db);
    expect(tamperedCp.valid).toBe(false);
    expect(tamperedCp.brokenCheckpointId).toBe(purgeRes.checkpointId);
    expect(tamperedCp.reason).toBe('CHECKPOINT_HASH_TAMPERED');

    // Restore checkpoint, then delete middle retained entry aud_seq_4 -> broken chain at aud_seq_5
    await db
      .prepare(`UPDATE audit_retention_checkpoints SET purged_count = 2 WHERE checkpoint_id = ?1`)
      .bind(purgeRes.checkpointId)
      .run();
    await db.prepare(`DELETE FROM audit_logs WHERE audit_id = 'aud_seq_4'`).run();
    const deletedMiddle = await auditRepository.verifyChainIntegrity(db);
    expect(deletedMiddle.valid).toBe(false);
    expect(deletedMiddle.brokenAuditId).toBe('aud_seq_5');
    expect(deletedMiddle.reason).toBe('AUDIT_PREV_HASH_MISMATCH');

    // Reordered entries test: swap row order of two chained entries in an isolated DB
    const reorderDb = new SqliteD1Adapter(':memory:');
    try {
      reorderDb.applyMigrations(MIGRATIONS_DIR);
      await auditRepository.appendImmediate(reorderDb, {
        auditId: 'aud_ord_1',
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'FIRST',
        resourceType: 'SYSTEM',
        resourceId: 'R1',
        result: 'SUCCESS',
        correlationId: 'cor_ord_1',
        nowMs: baseNow,
      });
      await auditRepository.appendImmediate(reorderDb, {
        auditId: 'aud_ord_2',
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'SECOND',
        resourceType: 'SYSTEM',
        resourceId: 'R2',
        result: 'SUCCESS',
        correlationId: 'cor_ord_2',
        nowMs: baseNow + 1,
      });
      const r1 = await reorderDb
        .prepare(`SELECT * FROM audit_logs WHERE audit_id = 'aud_ord_1'`)
        .first<AuditLogRow>();
      const r2 = await reorderDb
        .prepare(`SELECT * FROM audit_logs WHERE audit_id = 'aud_ord_2'`)
        .first<AuditLogRow>();
      await dropAuditImmutabilityTriggersForTamperTest(reorderDb);
      await reorderDb.prepare('DELETE FROM audit_logs').run();
      // Re-insert in reversed order (r2 then r1)
      const insertSql = `INSERT INTO audit_logs (
        audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
        before_state_json, after_state_json, reason, correlation_id, source_update_id,
        prev_entry_hash, entry_hash, hash_version, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;
      for (const r of [r2!, r1!]) {
        await reorderDb
          .prepare(insertSql)
          .bind(
            r.audit_id,
            r.actor_id,
            r.actor_role,
            r.action,
            r.resource_type,
            r.resource_id,
            r.result,
            r.before_state_json,
            r.after_state_json,
            r.reason,
            r.correlation_id,
            r.source_update_id,
            r.prev_entry_hash,
            r.entry_hash,
            r.hash_version,
            r.created_at
          )
          .run();
      }
      const reorderedCheck = await auditRepository.verifyChainIntegrity(reorderDb);
      expect(reorderedCheck.valid).toBe(false);
      expect(reorderedCheck.brokenAuditId).toBe('aud_ord_2');
      expect(reorderedCheck.reason).toBe('AUDIT_PREV_HASH_MISMATCH');
    } finally {
      reorderDb.close();
    }
  });

  it('F07-6. Preserves historical v1 rows across migration 0005 without rewriting hashes, and verifies mixed v1+v2 chains', async () => {
    const legacyDb = new SqliteD1Adapter(':memory:');
    try {
      // Apply ONLY migrations 0001..0004 (pre-F-07 schema)
      const preFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && f < '0005_')
        .sort();
      for (const file of preFiles) {
        await legacyDb.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      }

      const oldTs = baseNow - 400 * 86400000;
      const v1Hash1 = await computeAuditEntryHash({
        prevHash: 'GENESIS',
        auditId: 'aud_v1_old',
        actorId: '9001',
        actorRole: 'SUPER_ADMIN',
        action: 'LEGACY_ACTION_1',
        resourceType: 'SYSTEM',
        resourceId: 'SYS',
        result: 'SUCCESS',
        createdAt: oldTs,
        correlationId: 'cor_v1_1',
        hashVersion: 1,
      });

      const v1CpHash = await computeAuditCheckpointHash({
        prevCheckpointHash: 'GENESIS_CHECKPOINT',
        checkpointId: 'acp_v1_legacy',
        anchorAuditId: 'aud_v1_old',
        anchorEntryHash: v1Hash1,
        anchorCreatedAt: oldTs,
        purgedCount: 1,
        createdAt: oldTs + 1000,
        hashVersion: 1,
      });

      // Insert legacy v1 checkpoint + retained v1 audit entry chained from it
      await legacyDb
        .prepare(
          `INSERT INTO audit_retention_checkpoints (
             checkpoint_id, prev_checkpoint_hash, anchor_audit_id, anchor_entry_hash,
             anchor_created_at, purged_count, checkpoint_hash, created_at
           ) VALUES ('acp_v1_legacy', 'GENESIS_CHECKPOINT', 'aud_v1_old', ?1, ?2, 1, ?3, ?4)`
        )
        .bind(v1Hash1, oldTs, v1CpHash, oldTs + 1000)
        .run();

      const v1Hash2 = await computeAuditEntryHash({
        prevHash: v1Hash1,
        auditId: 'aud_v1_retained',
        actorId: '9001',
        actorRole: 'SUPER_ADMIN',
        action: 'LEGACY_ACTION_2',
        resourceType: 'DEPOSIT',
        resourceId: 'DEP-LEGACY-1',
        result: 'SUCCESS',
        createdAt: baseNow - 1000,
        correlationId: 'cor_v1_2',
        hashVersion: 1,
      });

      await legacyDb
        .prepare(
          `INSERT INTO audit_logs (
             audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
             before_state_json, after_state_json, reason, correlation_id, source_update_id,
             prev_entry_hash, entry_hash, created_at
           ) VALUES (
             'aud_v1_retained', '9001', 'SUPER_ADMIN', 'LEGACY_ACTION_2', 'DEPOSIT', 'DEP-LEGACY-1', 'SUCCESS',
             NULL, '{"legacy":true}', 'pre-0005 row', 'cor_v1_2', 123,
             ?1, ?2, ?3
           )`
        )
        .bind(v1Hash1, v1Hash2, baseNow - 1000)
        .run();

      // Now apply migration 0005 on top of existing v1 rows (must succeed despite BEFORE UPDATE immutability triggers!)
      const mig0005 = fs.readFileSync(
        path.join(MIGRATIONS_DIR, '0005_f03_f07_remediation.sql'),
        'utf8'
      );
      await legacyDb.exec(mig0005);

      // Verify historical rows default cleanly to hash_version = 1 with untouched hashes
      const migratedV1Row = await legacyDb
        .prepare(`SELECT entry_hash, hash_version FROM audit_logs WHERE audit_id = 'aud_v1_retained'`)
        .first<{ entry_hash: string; hash_version: number }>();
      expect(migratedV1Row!.entry_hash).toBe(v1Hash2);
      expect(migratedV1Row!.hash_version).toBe(1);

      const migratedV1Cp = await legacyDb
        .prepare(`SELECT checkpoint_hash, hash_version FROM audit_retention_checkpoints WHERE checkpoint_id = 'acp_v1_legacy'`)
        .first<{ checkpoint_hash: string; hash_version: number }>();
      expect(migratedV1Cp!.checkpoint_hash).toBe(v1CpHash);
      expect(migratedV1Cp!.hash_version).toBe(1);

      // Append new v2 row chained directly after historical v1 row
      await auditRepository.appendImmediate(legacyDb, {
        auditId: 'aud_v2_new',
        actorId: '9001',
        actorRole: 'SUPER_ADMIN',
        action: 'POST_MIGRATION_V2_ACTION',
        resourceType: 'WITHDRAWAL',
        resourceId: 'WD-NEW-1',
        result: 'SUCCESS',
        beforeState: { status: 'PENDING_ADMIN_REVIEW' },
        afterState: { status: 'APPROVED_FOR_PAYOUT' },
        reason: 'Manual verification passed',
        sourceUpdateId: 999,
        correlationId: 'cor_v2_1',
        nowMs: baseNow,
      });

      const newV2Row = await legacyDb
        .prepare(`SELECT prev_entry_hash, hash_version FROM audit_logs WHERE audit_id = 'aud_v2_new'`)
        .first<{ prev_entry_hash: string; hash_version: number }>();
      expect(newV2Row!.prev_entry_hash).toBe(v1Hash2);
      expect(newV2Row!.hash_version).toBe(2);

      // Mixed v1 checkpoint + v1 audit row + v2 audit row verifies cleanly!
      const mixedValid = await auditRepository.verifyChainIntegrity(legacyDb);
      expect(mixedValid.valid).toBe(true);
      expect(mixedValid.checkpointCount).toBe(1);
      expect(mixedValid.checkedCount).toBe(2);

      // Tampering either the historical v1 row OR the new v2 row fails verification
      await dropAuditImmutabilityTriggersForTamperTest(legacyDb);
      await legacyDb
        .prepare(`UPDATE audit_logs SET reason = 'FORGED_V2_REASON' WHERE audit_id = 'aud_v2_new'`)
        .run();
      const v2Tamper = await auditRepository.verifyChainIntegrity(legacyDb);
      expect(v2Tamper.valid).toBe(false);
      expect(v2Tamper.brokenAuditId).toBe('aud_v2_new');

      await legacyDb
        .prepare(`UPDATE audit_logs SET reason = 'Manual verification passed' WHERE audit_id = 'aud_v2_new'`)
        .run();
      await legacyDb
        .prepare(`UPDATE audit_logs SET action = 'FORGED_V1_ACTION' WHERE audit_id = 'aud_v1_retained'`)
        .run();
      const v1Tamper = await auditRepository.verifyChainIntegrity(legacyDb);
      expect(v1Tamper.valid).toBe(false);
      expect(v1Tamper.brokenAuditId).toBe('aud_v1_retained');
    } finally {
      legacyDb.close();
    }
  });
});
