import type { D1Database, D1PreparedStatement } from '../types/bindings';

export type UpdateLeaseDecision =
  | { action: 'ACQUIRED'; attemptCount: number }
  | { action: 'RECOVERED_LEASE'; attemptCount: number }
  | { action: 'DUPLICATE_COMPLETED' }
  | { action: 'ACTIVE_LEASE_HELD'; currentOwner: string | null }
  | { action: 'POISON_UPDATE_ABORTED'; attemptCount: number };

interface ProcessedUpdateRow {
  update_id: number;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
}

export const updateRepository = {
  async acquireLease(
    db: D1Database,
    updateId: number,
    workerId: string,
    nowMs: number,
    leaseDurationMs = 45000
  ): Promise<UpdateLeaseDecision> {
    const existing = await db
      .prepare('SELECT update_id, status, lease_owner, lease_expires_at, attempt_count FROM processed_updates WHERE update_id = ?1')
      .bind(updateId)
      .first<ProcessedUpdateRow>();

    const leaseExpiresAt = nowMs + leaseDurationMs;
    const expiresAt = nowMs + 14 * 24 * 60 * 60 * 1000;

    if (!existing) {
      const inserted = await db
        .prepare(
          `INSERT INTO processed_updates (
            update_id, status, lease_owner, lease_expires_at, attempt_count,
            received_at, processing_started_at, expires_at
          ) VALUES (?1, 'PROCESSING', ?2, ?3, 1, ?4, ?4, ?5)
          ON CONFLICT(update_id) DO NOTHING
          RETURNING update_id, status, lease_owner, attempt_count`
        )
        .bind(updateId, workerId, leaseExpiresAt, nowMs, expiresAt)
        .first<ProcessedUpdateRow>();

      if (inserted && inserted.lease_owner === workerId) {
        return { action: 'ACQUIRED', attemptCount: 1 };
      }
    }

    // Re-read or evaluate existing row under conflict
    const row =
      existing ??
      (await db
        .prepare('SELECT update_id, status, lease_owner, lease_expires_at, attempt_count FROM processed_updates WHERE update_id = ?1')
        .bind(updateId)
        .first<ProcessedUpdateRow>());

    if (!row) {
      throw new Error('FAILED_TO_READ_PROCESSED_UPDATE');
    }

    if (row.status === 'COMPLETED') {
      return { action: 'DUPLICATE_COMPLETED' };
    }

    if (row.status === 'PROCESSING' && row.lease_expires_at !== null && row.lease_expires_at > nowMs) {
      return { action: 'ACTIVE_LEASE_HELD', currentOwner: row.lease_owner };
    }

    if (row.attempt_count >= 5) {
      await db
        .prepare(
          `UPDATE processed_updates
           SET status = 'FAILED', last_error = 'MAX_UPDATE_ATTEMPTS_EXCEEDED', lease_owner = NULL
           WHERE update_id = ?1`
        )
        .bind(updateId)
        .run();
      return { action: 'POISON_UPDATE_ABORTED', attemptCount: row.attempt_count };
    }

    const reclaimed = await db
      .prepare(
        `UPDATE processed_updates
         SET status = 'PROCESSING',
             lease_owner = ?2,
             lease_expires_at = ?3,
             attempt_count = attempt_count + 1,
             processing_started_at = ?4
         WHERE update_id = ?1
           AND status != 'COMPLETED'
           AND (status != 'PROCESSING' OR lease_expires_at <= ?4)
         RETURNING update_id, attempt_count, lease_owner`
      )
      .bind(updateId, workerId, leaseExpiresAt, nowMs)
      .first<ProcessedUpdateRow>();

    if (!reclaimed || reclaimed.lease_owner !== workerId) {
      return { action: 'ACTIVE_LEASE_HELD', currentOwner: row.lease_owner };
    }

    return { action: 'RECOVERED_LEASE', attemptCount: reclaimed.attempt_count };
  },

  prepareCompleteStatement(
    db: D1Database,
    updateId: number,
    workerId: string,
    nowMs: number
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE processed_updates
         SET status = 'COMPLETED',
             completed_at = ?3,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE update_id = ?1
           AND status = 'PROCESSING'
           AND lease_owner = ?2
         RETURNING update_id`
      )
      .bind(updateId, workerId, nowMs);
  },

  async markFailed(db: D1Database, updateId: number, workerId: string, errorMsg: string): Promise<void> {
    await db
      .prepare(
        `UPDATE processed_updates
         SET status = 'FAILED',
             last_error = ?3,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE update_id = ?1 AND lease_owner = ?2`
      )
      .bind(updateId, workerId, errorMsg.slice(0, 500))
      .run();
  },
};
