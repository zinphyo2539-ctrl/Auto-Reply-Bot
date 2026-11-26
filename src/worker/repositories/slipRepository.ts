import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { SlipFingerprintRow, SlipReviewRow, SlipReviewStatus } from '../types/domain';

export const slipRepository = {
  async getSlipById(db: D1Database, slipId: string): Promise<SlipReviewRow | null> {
    return db
      .prepare('SELECT * FROM slip_reviews WHERE slip_id = ?1')
      .bind(slipId)
      .first<SlipReviewRow>();
  },

  async getFingerprint(db: D1Database, fileUniqueId: string): Promise<SlipFingerprintRow | null> {
    return db
      .prepare('SELECT * FROM slip_fingerprints WHERE file_unique_id = ?1')
      .bind(fileUniqueId)
      .first<SlipFingerprintRow>();
  },

  async getLatestByTicket(db: D1Database, ticketId: string): Promise<SlipReviewRow | null> {
    return db
      .prepare(
        `SELECT * FROM slip_reviews
         WHERE ticket_id = ?1
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(ticketId)
      .first<SlipReviewRow>();
  },

  prepareAtomicFingerprintUpsert(
    db: D1Database,
    params: {
      fileUniqueId: string;
      customerId: string;
      slipId: string;
      ticketId: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO slip_fingerprints (
          file_unique_id, first_customer_id, first_slip_id, first_ticket_id,
          first_seen_at, occurrence_count, last_customer_id, last_slip_id, last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?2, ?3, ?5)
        ON CONFLICT(file_unique_id) DO UPDATE SET
          occurrence_count = slip_fingerprints.occurrence_count + 1,
          last_customer_id = excluded.last_customer_id,
          last_slip_id = excluded.last_slip_id,
          last_seen_at = excluded.last_seen_at
        RETURNING *`
      )
      .bind(params.fileUniqueId, params.customerId, params.slipId, params.ticketId, params.nowMs);
  },

  prepareInsertSlipReviewFromFingerprint(
    db: D1Database,
    params: {
      slipId: string;
      ticketId: string;
      customerId: string;
      fileId: string;
      fileUniqueId: string;
      initialStatus: SlipReviewStatus;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO slip_reviews (
          slip_id, ticket_id, customer_id, file_id, file_unique_id,
          is_duplicate_warning, duplicate_context_json, review_status,
          version, last_mutation_token, created_at, updated_at
        )
        SELECT
          ?1, ?2, ?3, ?4, ?5,
          CASE WHEN fp.occurrence_count > 1 THEN 1 ELSE 0 END,
          CASE WHEN fp.occurrence_count > 1 THEN json_object(
            'firstCustomerId', fp.first_customer_id,
            'firstSlipId', fp.first_slip_id,
            'firstTicketId', fp.first_ticket_id,
            'firstSeenAt', fp.first_seen_at,
            'occurrenceCount', fp.occurrence_count,
            'isCrossCustomer', CASE WHEN fp.first_customer_id != ?3 THEN 1 ELSE 0 END
          ) ELSE NULL END,
          ?6, 1, ?7, ?8, ?8
        FROM slip_fingerprints fp
        WHERE fp.file_unique_id = ?5
        RETURNING *`
      )
      .bind(
        params.slipId,
        params.ticketId,
        params.customerId,
        params.fileId,
        params.fileUniqueId,
        params.initialStatus,
        params.mutationToken,
        params.nowMs
      );
  },

  prepareTransitionToUnderReviewOnClaim(
    db: D1Database,
    ticketId: string,
    mutationToken: string,
    nowMs: number
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE slip_reviews
         SET review_status = 'UNDER_REVIEW',
             version = version + 1,
             last_mutation_token = ?2,
             updated_at = ?3
         WHERE ticket_id = ?1
           AND review_status = 'RECEIVED'
           AND EXISTS (
             SELECT 1 FROM support_tickets
             WHERE ticket_id = ?1 AND last_mutation_token = ?2
           )`
      )
      .bind(ticketId, mutationToken, nowMs);
  },

  prepareAtomicAdminReviewDecision(
    db: D1Database,
    params: {
      slipId: string;
      actorAdminId: string;
      decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';
      reviewNote: string | null;
      expectedVersion?: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    if (params.expectedVersion !== undefined) {
      return db
        .prepare(
          `UPDATE slip_reviews
           SET review_status = ?2,
               reviewed_by_admin_id = ?3,
               review_note = ?4,
               reviewed_at = ?5,
               version = version + 1,
               last_mutation_token = ?6,
               updated_at = ?5
           WHERE slip_id = ?1
             AND version = ?7
             AND review_status IN ('RECEIVED', 'UNDER_REVIEW', 'NEEDS_INFO')
             AND EXISTS (
               SELECT 1 FROM admins
               WHERE telegram_user_id = ?3
                 AND is_active = 1
                 AND (role = 'SUPER_ADMIN' OR instr(permissions_json, '"slip.review"') > 0)
             )
           RETURNING *`
        )
        .bind(
          params.slipId,
          params.decision,
          params.actorAdminId,
          params.reviewNote,
          params.nowMs,
          params.mutationToken,
          params.expectedVersion
        );
    }

    return db
      .prepare(
        `UPDATE slip_reviews
         SET review_status = ?2,
             reviewed_by_admin_id = ?3,
             review_note = ?4,
             reviewed_at = ?5,
             version = version + 1,
             last_mutation_token = ?6,
             updated_at = ?5
         WHERE slip_id = ?1
           AND review_status IN ('RECEIVED', 'UNDER_REVIEW', 'NEEDS_INFO')
           AND EXISTS (
             SELECT 1 FROM admins
             WHERE telegram_user_id = ?3
               AND is_active = 1
               AND (role = 'SUPER_ADMIN' OR instr(permissions_json, '"slip.review"') > 0)
           )
         RETURNING *`
      )
      .bind(
        params.slipId,
        params.decision,
        params.actorAdminId,
        params.reviewNote,
        params.nowMs,
        params.mutationToken
      );
  },
};
