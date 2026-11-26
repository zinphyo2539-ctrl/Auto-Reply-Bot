import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { AuditLogRow } from '../types/domain';
import { computeAuditEntryHash } from '../lib/crypto';
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

export const auditRepository = {
  async getLatestHash(db: D1Database): Promise<string> {
    const row = await db
      .prepare('SELECT entry_hash FROM audit_logs ORDER BY created_at DESC, audit_id DESC LIMIT 1')
      .first<{ entry_hash: string }>();
    return row?.entry_hash ?? 'GENESIS';
  },

  async buildInsertStatement(
    db: D1Database,
    input: CreateAuditInput,
    gateCondition?: { table: string; pkColumn: string; pkValue: string; mutationToken: string }
  ): Promise<D1PreparedStatement> {
    const auditId = input.auditId ?? generatePrefixedId('aud', input.nowMs);
    const prevHash = await this.getLatestHash(db);
    const entryHash = await computeAuditEntryHash({
      prevHash,
      auditId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: input.result,
      createdAt: input.nowMs,
      correlationId: input.correlationId,
    });

    const beforeJson = input.beforeState ? JSON.stringify(input.beforeState) : null;
    const afterJson = input.afterState ? JSON.stringify(input.afterState) : null;

    if (gateCondition) {
      return db
        .prepare(
          `INSERT INTO audit_logs (
            audit_id, actor_id, actor_role, action, resource_type, resource_id, result,
            before_state_json, after_state_json, reason, correlation_id, source_update_id,
            prev_entry_hash, entry_hash, created_at
          ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
          WHERE EXISTS (
            SELECT 1 FROM ${gateCondition.table}
            WHERE ${gateCondition.pkColumn} = ?16 AND last_mutation_token = ?17
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
          input.reason ?? null,
          input.correlationId,
          input.sourceUpdateId ?? null,
          prevHash,
          entryHash,
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
          prev_entry_hash, entry_hash, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
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
        input.reason ?? null,
        input.correlationId,
        input.sourceUpdateId ?? null,
        prevHash,
        entryHash,
        input.nowMs
      );
  },

  async appendImmediate(db: D1Database, input: CreateAuditInput): Promise<void> {
    const stmt = await this.buildInsertStatement(db, input);
    await stmt.run();
  },

  async listRecent(db: D1Database, limit = 20): Promise<AuditLogRow[]> {
    const res = await db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, audit_id DESC LIMIT ?1')
      .bind(limit)
      .all<AuditLogRow>();
    return res.results;
  },

  async verifyChainIntegrity(db: D1Database): Promise<{ valid: boolean; checkedCount: number; brokenAuditId?: string }> {
    const res = await db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at ASC, rowid ASC')
      .all<AuditLogRow>();

    let expectedPrev = 'GENESIS';
    for (const row of res.results) {
      if (row.prev_entry_hash !== expectedPrev) {
        return { valid: false, checkedCount: res.results.length, brokenAuditId: row.audit_id };
      }
      const computed = await computeAuditEntryHash({
        prevHash: row.prev_entry_hash,
        auditId: row.audit_id,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        result: row.result,
        createdAt: row.created_at,
        correlationId: row.correlation_id,
      });
      if (computed !== row.entry_hash) {
        return { valid: false, checkedCount: res.results.length, brokenAuditId: row.audit_id };
      }
      expectedPrev = row.entry_hash;
    }
    return { valid: true, checkedCount: res.results.length };
  },
};
