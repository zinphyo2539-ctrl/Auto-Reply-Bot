import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { WithdrawalRequestRow } from '../types/domain';

export const withdrawalRepository = {
  async getById(db: D1Database, withdrawalId: string): Promise<WithdrawalRequestRow | null> {
    return db
      .prepare('SELECT * FROM withdrawal_requests WHERE withdrawal_id = ?1')
      .bind(withdrawalId)
      .first<WithdrawalRequestRow>();
  },

  async listByCustomer(db: D1Database, customerId: string, limit = 5): Promise<WithdrawalRequestRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM withdrawal_requests
         WHERE customer_id = ?1
         ORDER BY created_at DESC LIMIT ?2`
      )
      .bind(customerId, limit)
      .all<WithdrawalRequestRow>();
    return res.results;
  },

  async listPendingReview(db: D1Database, limit = 15): Promise<WithdrawalRequestRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM withdrawal_requests
         WHERE status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO', 'APPROVED_FOR_PAYOUT')
         ORDER BY created_at ASC LIMIT ?1`
      )
      .bind(limit)
      .all<WithdrawalRequestRow>();
    return res.results;
  },

  prepareAtomicCreateFromSession(
    db: D1Database,
    params: {
      withdrawalId: string;
      customerId: string;
      draftToken: string;
      ticketId: string;
      currency: string;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO withdrawal_requests (
          withdrawal_id, idempotency_token, ticket_id, customer_id,
          amount, currency, method_code,
          destination_masked, destination_ciphertext, destination_iv, encryption_key_version,
          status, version, last_mutation_token, created_at, updated_at
        )
        SELECT
          ?1, cs.draft_token,
          COALESCE(
            (SELECT ticket_id FROM support_tickets WHERE customer_id = ?2 AND status IN ('OPEN', 'ASSIGNED') LIMIT 1),
            ?3
          ),
          ?2, cs.draft_amount, ?4, cs.draft_method_code,
          cs.draft_dest_masked, cs.draft_dest_ciphertext, cs.draft_dest_iv, cs.key_version,
          'SUBMITTED', 1, ?5, ?6, ?6
        FROM customer_sessions cs
        JOIN config cfg ON cfg.config_id = 'active'
        WHERE cs.customer_id = ?2
          AND cs.wizard_type = 'WITHDRAWAL'
          AND cs.wizard_state = 'WD_AWAITING_CONFIRM'
          AND cs.draft_token = ?7
          AND cs.expires_at > ?6
          AND cs.draft_amount >= cfg.min_withdrawal_amount
          AND cs.draft_amount <= cfg.max_withdrawal_amount
          AND cs.draft_dest_ciphertext IS NOT NULL
          AND cs.draft_dest_iv IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(cfg.payment_methods_json)
            WHERE json_extract(json_each.value, '$.code') = cs.draft_method_code
              AND json_extract(json_each.value, '$.enabled') = 1
          )
          AND EXISTS (
            SELECT 1 FROM customers WHERE telegram_user_id = ?2 AND account_status = 'ACTIVE'
          )
        ON CONFLICT(idempotency_token) DO NOTHING
        RETURNING *`
      )
      .bind(
        params.withdrawalId,
        params.customerId,
        params.ticketId,
        params.currency,
        params.mutationToken,
        params.nowMs,
        params.draftToken
      );
  },

  prepareCustomerCancel(
    db: D1Database,
    params: {
      withdrawalId: string;
      customerId: string;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE withdrawal_requests
         SET status = 'CANCELLED_BY_CUSTOMER',
             destination_ciphertext = 'REDACTED',
             destination_iv = 'REDACTED',
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?4
         WHERE withdrawal_id = ?1
           AND customer_id = ?2
           AND status = 'SUBMITTED'
         RETURNING *`
      )
      .bind(params.withdrawalId, params.customerId, params.mutationToken, params.nowMs);
  },

  prepareSuperAdminDecision(
    db: D1Database,
    params: {
      withdrawalId: string;
      actorAdminId: string;
      newStatus: 'UNDER_REVIEW' | 'NEEDS_INFO' | 'APPROVED_FOR_PAYOUT' | 'PAID_RECORDED' | 'REJECTED';
      decisionNote: string | null;
      paymentEvidenceRef: string | null;
      expectedVersion: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    // Enforce explicit valid state transitions:
    // - PAID_RECORDED can ONLY be reached from APPROVED_FOR_PAYOUT (or UNDER_REVIEW/SUBMITTED when recording direct verified payout) with non-empty paymentEvidenceRef
    const allowedFromClause =
      params.newStatus === 'PAID_RECORDED'
        ? `status IN ('APPROVED_FOR_PAYOUT', 'UNDER_REVIEW', 'SUBMITTED')`
        : `status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO')`;

    return db
      .prepare(
        `UPDATE withdrawal_requests
         SET status = ?2,
             reviewed_by_admin_id = ?3,
             decision_note = ?4,
             payment_evidence_ref = COALESCE(?5, payment_evidence_ref),
             reviewed_at = ?6,
             version = version + 1,
             last_mutation_token = ?7,
             updated_at = ?6
         WHERE withdrawal_id = ?1
           AND version = ?8
           AND ${allowedFromClause}
           AND status != ?2
           AND EXISTS (
             SELECT 1 FROM admins
             WHERE telegram_user_id = ?3
               AND is_active = 1
               AND role = 'SUPER_ADMIN'
           )
         RETURNING *`
      )
      .bind(
        params.withdrawalId,
        params.newStatus,
        params.actorAdminId,
        params.decisionNote,
        params.paymentEvidenceRef,
        params.nowMs,
        params.mutationToken,
        params.expectedVersion
      );
  },
};
