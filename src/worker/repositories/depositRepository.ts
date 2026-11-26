import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { DepositRequestRow } from '../types/domain';

export const depositRepository = {
  async getById(db: D1Database, depositId: string): Promise<DepositRequestRow | null> {
    return db
      .prepare('SELECT * FROM deposit_requests WHERE deposit_id = ?1')
      .bind(depositId)
      .first<DepositRequestRow>();
  },

  async listByCustomer(db: D1Database, customerId: string, limit = 5): Promise<DepositRequestRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM deposit_requests
         WHERE customer_id = ?1
         ORDER BY created_at DESC LIMIT ?2`
      )
      .bind(customerId, limit)
      .all<DepositRequestRow>();
    return res.results;
  },

  async listPendingReview(db: D1Database, limit = 15): Promise<DepositRequestRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM deposit_requests
         WHERE status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO')
         ORDER BY created_at ASC LIMIT ?1`
      )
      .bind(limit)
      .all<DepositRequestRow>();
    return res.results;
  },

  prepareAtomicCreateFromSession(
    db: D1Database,
    params: {
      depositId: string;
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
        `INSERT INTO deposit_requests (
          deposit_id, idempotency_token, ticket_id, customer_id,
          amount, currency, method_code, customer_reference_text, slip_id,
          status, version, last_mutation_token, created_at, updated_at
        )
        SELECT
          ?1, cs.draft_token,
          COALESCE(
            (SELECT ticket_id FROM support_tickets WHERE customer_id = ?2 AND status IN ('OPEN', 'ASSIGNED') LIMIT 1),
            ?3
          ),
          ?2, cs.draft_amount, ?4, cs.draft_method_code, cs.draft_reference_text, NULL,
          'SUBMITTED', 1, ?5, ?6, ?6
        FROM customer_sessions cs
        JOIN config cfg ON cfg.config_id = 'active'
        WHERE cs.customer_id = ?2
          AND cs.wizard_type = 'DEPOSIT'
          AND cs.wizard_state = 'DEP_AWAITING_CONFIRM'
          AND cs.draft_token = ?7
          AND cs.expires_at > ?6
          AND cs.draft_amount >= cfg.min_deposit_amount
          AND cs.draft_amount <= cfg.max_deposit_amount
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
        params.depositId,
        params.customerId,
        params.ticketId,
        params.currency,
        params.mutationToken,
        params.nowMs,
        params.draftToken
      );
  },

  async getLatestByTicket(db: D1Database, ticketId: string): Promise<DepositRequestRow | null> {
    return db
      .prepare(
        `SELECT * FROM deposit_requests
         WHERE ticket_id = ?1
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(ticketId)
      .first<DepositRequestRow>();
  },

  prepareCustomerCancel(
    db: D1Database,
    params: {
      depositId: string;
      customerId: string;
      expectedVersion?: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    if (params.expectedVersion !== undefined) {
      return db
        .prepare(
          `UPDATE deposit_requests
           SET status = 'CANCELLED_BY_CUSTOMER',
               version = version + 1,
               last_mutation_token = ?3,
               updated_at = ?4
           WHERE deposit_id = ?1
             AND customer_id = ?2
             AND status = 'SUBMITTED'
             AND version = ?5
           RETURNING *`
        )
        .bind(
          params.depositId,
          params.customerId,
          params.mutationToken,
          params.nowMs,
          params.expectedVersion
        );
    }

    return db
      .prepare(
        `UPDATE deposit_requests
         SET status = 'CANCELLED_BY_CUSTOMER',
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?4
         WHERE deposit_id = ?1
           AND customer_id = ?2
           AND status = 'SUBMITTED'
         RETURNING *`
      )
      .bind(params.depositId, params.customerId, params.mutationToken, params.nowMs);
  },

  prepareSuperAdminDecision(
    db: D1Database,
    params: {
      depositId: string;
      actorAdminId: string;
      newStatus: 'UNDER_REVIEW' | 'NEEDS_INFO' | 'APPROVED_MANUAL_CREDITED' | 'REJECTED';
      decisionNote: string | null;
      adminEvidenceRef: string | null;
      expectedVersion: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE deposit_requests
         SET status = ?2,
             reviewed_by_admin_id = ?3,
             decision_note = ?4,
             admin_operation_evidence_ref = COALESCE(?5, admin_operation_evidence_ref),
             reviewed_at = ?6,
             version = version + 1,
             last_mutation_token = ?7,
             updated_at = ?6
         WHERE deposit_id = ?1
           AND version = ?8
           AND status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO')
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
        params.depositId,
        params.newStatus,
        params.actorAdminId,
        params.decisionNote,
        params.adminEvidenceRef,
        params.nowMs,
        params.mutationToken,
        params.expectedVersion
      );
  },
};
