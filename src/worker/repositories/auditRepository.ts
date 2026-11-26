import type { D1Database, D1PreparedStatement, D1Result } from '../types/bindings';
import type { AuditLogRow, AuditRetentionCheckpointRow } from '../types/domain';
import {
  CURRENT_AUDIT_HASH_VERSION,
  CURRENT_CHECKPOINT_HASH_VERSION,
  computeAuditCheckpointHash,
  computeAuditEntryHash,
  serializeCanonicalJson,
} from '../lib/crypto';
import { DatabaseError } from '../lib/errors';
import { generatePrefixedId } from '../lib/ids';

export interface CreateAuditInput {
  auditId?: string;
  actorId: string;
  actorRole: 'SUPER_ADMIN' | 'SUPPORT_AGENT' | 'CUSTOMER' | 'SYSTEM' | 'UNAUTHORIZED';
  action: string;
  resourceType: 'TICKET' | 'SLIP' | 'DEPOSIT' | 'WITHDRAWAL' | 'CUSTOMER' | 'ADMIN' | 'CONFIG' | 'FAQ' | 'OUTBOX' | 'SYSTEM';
  resourceId: string;
  result: 'SUCCESS' | 'DENIED' | 'CONFLICT' | 'FAILURE';
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
  correlationId: string;
  sourceUpdateId?: number | null;
  nowMs: number;
}

export interface AuditGateCondition {
  table: string;
  pkColumn: string;
  pkValue: string;
  mutationToken: string;
}

const MAX_AUDIT_CHAIN_RETRIES = 8;

function isPrevHashCollisionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /UNIQUE constraint failed:\s*audit_logs\.prev_entry_hash/i.test(msg) ||
    /idx_audit_logs_unique_prev_hash/i.test(msg)
  );
}

export const auditRepository = {
  async getLatestCheckpoint(db: D1Database): Promise<AuditRetentionCheckpointRow | null> {
    return db
      .prepare('SELECT * FROM audit_retention_checkpoints ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .first<AuditRetentionCheckpointRow>();
  },

  async getLatestHash(db: D1Database): Promise<string> {
    const row = await db
      .prepare('SELECT entry_hash FROM audit_logs ORDER BY rowid DESC LIMIT 1')
      .first<{ entry_hash: string }>();
    if (row?.entry_hash) {
      return row.entry_hash;
    }
    const checkpoint = await this.getLatestCheckpoint(db);
    return checkpoint?.anchor_entry_hash ?? 'GENESIS';
  },

  async buildInsertStatement(
    db: D1Database,
    input: CreateAuditInput,
    gateCondition?: AuditGateCondition,
    explicitPrevHash?: string
  ): Promise<D1PreparedStatement> {
    const auditId = input.auditId ?? generatePrefixedId('aud', input.nowMs);
    const prevHash = explicitPrevHash ?? (await this.getLatestHash(db));
    const beforeJson = serializeCanonicalJson(input.beforeState);
    const afterJson = serializeCanonicalJson(input.afterState);
    const reason = input.reason ?? null;
    const sourceUpdateId = input.sourceUpdateId ?? null;
    const hashVersion = CURRENT_AUDIT_HASH_VERSION;

    const entryHash = await computeAuditEntryHash({
      prevHash,
      auditId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: input.result,
      beforeStateJson: beforeJson,
      afterStateJson: afterJson,
      reason,
      sourceUpdateId,
      createdAt: input.nowMs,
      correlationId: input.correlationId,
      hashVersion,
    });

    if (gateCondition) {
      return db
        .prepare(
          `INSERT INTO audit_logs (
            audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
            before_state_json, after_state_json, reason, correlation_id, source_update_id,
            prev_entry_hash, entry_hash, hash_version, created_at
          ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
          WHERE EXISTS (
            SELECT 1 FROM ${gateCondition.table}
            WHERE ${gateCondition.pkColumn} = ?17 AND last_mutation_token = ?18
          )`
        )
        .bind(
          auditId,
          input.actorId,
          input.actorRole,
          input.action,
          input.resourceType,
          input.resourceId,
          input.result,
          beforeJson,
          afterJson,
          reason,
          input.correlationId,
          sourceUpdateId,
          prevHash,
          entryHash,
          hashVersion,
          input.nowMs,
          gateCondition.pkValue,
          gateCondition.mutationToken
        );
    }

    return db
      .prepare(
        `INSERT INTO audit_logs (
          audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
          before_state_json, after_state_json, reason, correlation_id, source_update_id,
          prev_entry_hash, entry_hash, hash_version, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
      )
      .bind(
        auditId,
        input.actorId,
        input.actorRole,
        input.action,
        input.resourceType,
        input.resourceId,
        input.result,
        beforeJson,
        afterJson,
        reason,
        input.correlationId,
        sourceUpdateId,
        prevHash,
        entryHash,
        hashVersion,
        input.nowMs
      );
  },

  /**
   * Serializes concurrent audit chain appends using the database-enforced UNIQUE(prev_entry_hash)
   * constraint as an atomic compare-and-swap lock, retrying with the latest chain head on collision.
   */
  async appendImmediate(db: D1Database, input: CreateAuditInput): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_AUDIT_CHAIN_RETRIES; attempt++) {
      try {
        const stmt = await this.buildInsertStatement(db, {
          ...input,
          auditId: input.auditId ?? generatePrefixedId('aud', input.nowMs),
        });
        await stmt.run();
        return;
      } catch (err) {
        if (isPrevHashCollisionError(err) && attempt < MAX_AUDIT_CHAIN_RETRIES) {
          lastError = err;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(`Authoritative audit append failed: ${msg}`);
      }
    }
    throw new DatabaseError(
      `Authoritative audit append exhausted chain retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  },

  /**
   * Executes an atomic D1 batch containing an audit insert with bounded retry on
   * concurrent audit_logs.prev_entry_hash collision. Because D1 rolls back the full
   * batch on any constraint failure, retrying with a fresh prev_entry_hash is atomic and safe.
   */
  async executeBatchWithAudit(
    db: D1Database,
    buildBatch: (auditStmt: D1PreparedStatement) => D1PreparedStatement[],
    auditInput: CreateAuditInput,
    gateCondition?: AuditGateCondition
  ): Promise<D1Result[]> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_AUDIT_CHAIN_RETRIES; attempt++) {
      try {
        const auditStmt = await this.buildInsertStatement(
          db,
          {
            ...auditInput,
            auditId: auditInput.auditId ?? generatePrefixedId('aud', auditInput.nowMs),
          },
          gateCondition
        );
        const statements = buildBatch(auditStmt);
        if (statements.length === 0) {
          return [];
        }
        return await db.batch(statements);
      } catch (err) {
        if (isPrevHashCollisionError(err) && attempt < MAX_AUDIT_CHAIN_RETRIES) {
          lastError = err;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(`D1 atomic batch failed: ${msg}`);
      }
    }
    throw new DatabaseError(
      `D1 atomic batch exhausted audit chain retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  },

  async listRecent(db: D1Database, limit = 20): Promise<AuditLogRow[]> {
    const res = await db
      .prepare('SELECT * FROM audit_logs ORDER BY rowid DESC LIMIT ?1')
      .bind(limit)
      .all<AuditLogRow>();
    return res.results;
  },

  /**
   * Verifies end-to-end cryptographic integrity across:
   * 1. All immutable audit_retention_checkpoints from GENESIS_CHECKPOINT;
   * 2. All retained audit_logs chained continuously from the latest checkpoint anchor (or GENESIS).
   */
  async verifyChainIntegrity(db: D1Database): Promise<{
    valid: boolean;
    checkedCount: number;
    checkpointCount: number;
    brokenAuditId?: string;
    brokenCheckpointId?: string;
    reason?: string;
  }> {
    const [cpRes, logRes] = await Promise.all([
      db.prepare('SELECT * FROM audit_retention_checkpoints ORDER BY rowid ASC').all<AuditRetentionCheckpointRow>(),
      db.prepare('SELECT * FROM audit_logs ORDER BY rowid ASC').all<AuditLogRow>(),
    ]);

    let expectedPrevCheckpoint = 'GENESIS_CHECKPOINT';
    let lastCheckpoint: AuditRetentionCheckpointRow | null = null;

    for (const cp of cpRes.results) {
      if (cp.prev_checkpoint_hash !== expectedPrevCheckpoint) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenCheckpointId: cp.checkpoint_id,
          reason: 'CHECKPOINT_PREV_HASH_MISMATCH',
        };
      }
      const cpHashVersion = cp.hash_version;
      if (typeof cpHashVersion !== 'number' || !Number.isInteger(cpHashVersion)) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenCheckpointId: cp.checkpoint_id,
          reason: 'UNSUPPORTED_CHECKPOINT_HASH_VERSION',
        };
      }
      let computedCpHash: string;
      try {
        computedCpHash = await computeAuditCheckpointHash({
          prevCheckpointHash: cp.prev_checkpoint_hash,
          checkpointId: cp.checkpoint_id,
          anchorAuditId: cp.anchor_audit_id,
          anchorEntryHash: cp.anchor_entry_hash,
          anchorCreatedAt: cp.anchor_created_at,
          purgedCount: cp.purged_count,
          createdAt: cp.created_at,
          hashVersion: cpHashVersion,
        });
      } catch {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenCheckpointId: cp.checkpoint_id,
          reason: 'UNSUPPORTED_CHECKPOINT_HASH_VERSION',
        };
      }
      if (computedCpHash !== cp.checkpoint_hash) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenCheckpointId: cp.checkpoint_id,
          reason: 'CHECKPOINT_HASH_TAMPERED',
        };
      }
      expectedPrevCheckpoint = cp.checkpoint_hash;
      lastCheckpoint = cp;
    }

    let expectedPrev = lastCheckpoint ? lastCheckpoint.anchor_entry_hash : 'GENESIS';
    for (const row of logRes.results) {
      if (row.prev_entry_hash !== expectedPrev) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenAuditId: row.audit_id,
          reason: 'AUDIT_PREV_HASH_MISMATCH',
        };
      }
      const rowHashVersion = row.hash_version;
      if (typeof rowHashVersion !== 'number' || !Number.isInteger(rowHashVersion)) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenAuditId: row.audit_id,
          reason: 'UNSUPPORTED_AUDIT_HASH_VERSION',
        };
      }
      let computed: string;
      try {
        computed = await computeAuditEntryHash({
          prevHash: row.prev_entry_hash,
          auditId: row.audit_id,
          actorId: row.actor_id,
          actorRole: row.actor_role,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          result: row.result,
          beforeStateJson: row.before_state_json,
          afterStateJson: row.after_state_json,
          reason: row.reason,
          sourceUpdateId: row.source_update_id,
          createdAt: row.created_at,
          correlationId: row.correlation_id,
          hashVersion: rowHashVersion,
        });
      } catch {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenAuditId: row.audit_id,
          reason: 'UNSUPPORTED_AUDIT_HASH_VERSION',
        };
      }
      if (computed !== row.entry_hash) {
        return {
          valid: false,
          checkedCount: logRes.results.length,
          checkpointCount: cpRes.results.length,
          brokenAuditId: row.audit_id,
          reason: 'AUDIT_ENTRY_HASH_TAMPERED',
        };
      }
      expectedPrev = row.entry_hash;
    }

    return {
      valid: true,
      checkedCount: logRes.results.length,
      checkpointCount: cpRes.results.length,
    };
  },

  /**
   * Purges a bounded prefix of expired audit_logs ONLY after verifying their cryptographic
   * continuity from the current anchor, atomically recording an immutable checkpoint row first.
   */
  async purgeExpiredWithCheckpoint(
    db: D1Database,
    cutoffMs: number,
    nowMs: number,
    limit = 500
  ): Promise<{ purgedCount: number; checkpointId: string | null }> {
    const boundedLimit = Math.min(Math.max(1, limit), 500);
    // Read oldest contiguous rows from the start of the retained chain
    const oldestRes = await db
      .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC LIMIT ?1')
      .bind(boundedLimit)
      .all<AuditLogRow>();

    // Only purge a strict contiguous prefix whose created_at <= cutoffMs
    const toPurge: AuditLogRow[] = [];
    for (const row of oldestRes.results) {
      if (row.created_at <= cutoffMs) {
        toPurge.push(row);
      } else {
        break;
      }
    }

    if (toPurge.length === 0) {
      return { purgedCount: 0, checkpointId: null };
    }

    const latestCheckpoint = await this.getLatestCheckpoint(db);
    let expectedPrev = latestCheckpoint ? latestCheckpoint.anchor_entry_hash : 'GENESIS';

    // Fail closed if the prefix slated for deletion fails cryptographic verification
    for (const row of toPurge) {
      if (row.prev_entry_hash !== expectedPrev) {
        throw new DatabaseError(`AUDIT_RETENTION_ABORTED_BROKEN_CHAIN_AT_${row.audit_id}`);
      }
      const rowHashVersion = row.hash_version;
      if (typeof rowHashVersion !== 'number' || !Number.isInteger(rowHashVersion)) {
        throw new DatabaseError(`AUDIT_RETENTION_ABORTED_UNSUPPORTED_HASH_VERSION_AT_${row.audit_id}`);
      }
      let computed: string;
      try {
        computed = await computeAuditEntryHash({
          prevHash: row.prev_entry_hash,
          auditId: row.audit_id,
          actorId: row.actor_id,
          actorRole: row.actor_role,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          result: row.result,
          beforeStateJson: row.before_state_json,
          afterStateJson: row.after_state_json,
          reason: row.reason,
          sourceUpdateId: row.source_update_id,
          createdAt: row.created_at,
          correlationId: row.correlation_id,
          hashVersion: rowHashVersion,
        });
      } catch {
        throw new DatabaseError(`AUDIT_RETENTION_ABORTED_UNSUPPORTED_HASH_VERSION_AT_${row.audit_id}`);
      }
      if (computed !== row.entry_hash) {
        throw new DatabaseError(`AUDIT_RETENTION_ABORTED_TAMPERED_HASH_AT_${row.audit_id}`);
      }
      expectedPrev = row.entry_hash;
    }

    const anchorRow = toPurge[toPurge.length - 1];
    const checkpointId = generatePrefixedId('acp', nowMs);
    const prevCheckpointHash = latestCheckpoint ? latestCheckpoint.checkpoint_hash : 'GENESIS_CHECKPOINT';
    const checkpointHashVersion = CURRENT_CHECKPOINT_HASH_VERSION;
    const checkpointHash = await computeAuditCheckpointHash({
      prevCheckpointHash,
      checkpointId,
      anchorAuditId: anchorRow.audit_id,
      anchorEntryHash: anchorRow.entry_hash,
      anchorCreatedAt: anchorRow.created_at,
      purgedCount: toPurge.length,
      createdAt: nowMs,
      hashVersion: checkpointHashVersion,
    });

    const insertCheckpointStmt = db
      .prepare(
        `INSERT INTO audit_retention_checkpoints (
          checkpoint_id, prev_checkpoint_hash, anchor_audit_id, anchor_entry_hash,
          anchor_created_at, purged_count, checkpoint_hash, hash_version, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        checkpointId,
        prevCheckpointHash,
        anchorRow.audit_id,
        anchorRow.entry_hash,
        anchorRow.created_at,
        toPurge.length,
        checkpointHash,
        checkpointHashVersion,
        nowMs
      );

    // D1 supports up to 100 bind parameters per query; chunk parameterized DELETE statements safely in groups of 50
    const deleteStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < toPurge.length; i += 50) {
      const slice = toPurge.slice(i, i + 50);
      const placeholders = slice.map((_, idx) => `?${idx + 1}`).join(', ');
      deleteStmts.push(
        db
          .prepare(`DELETE FROM audit_logs WHERE audit_id IN (${placeholders})`)
          .bind(...slice.map((r) => r.audit_id))
      );
    }

    const results = await db.batch([insertCheckpointStmt, ...deleteStmts]);
    let totalDeleted = 0;
    for (let i = 1; i < results.length; i++) {
      totalDeleted += results[i]?.meta.changes ?? 0;
    }
    return { purgedCount: totalDeleted, checkpointId };
  },
};
