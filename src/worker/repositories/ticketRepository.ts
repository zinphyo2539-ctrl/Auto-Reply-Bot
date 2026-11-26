import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { SupportTicketRow, TicketType } from '../types/domain';

export const ticketRepository = {
  async getById(db: D1Database, ticketId: string): Promise<SupportTicketRow | null> {
    return db
      .prepare('SELECT * FROM support_tickets WHERE ticket_id = ?1')
      .bind(ticketId)
      .first<SupportTicketRow>();
  },

  async findActiveByCustomer(db: D1Database, customerId: string): Promise<SupportTicketRow | null> {
    return db
      .prepare(
        `SELECT * FROM support_tickets
         WHERE customer_id = ?1 AND status IN ('OPEN', 'ASSIGNED')
         ORDER BY created_at DESC, ticket_id DESC
         LIMIT 1`
      )
      .bind(customerId)
      .first<SupportTicketRow>();
  },

  async listActiveByCustomer(db: D1Database, customerId: string, limit = 10): Promise<SupportTicketRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM support_tickets
         WHERE customer_id = ?1 AND status IN ('OPEN', 'ASSIGNED')
         ORDER BY created_at DESC, ticket_id DESC
         LIMIT ?2`
      )
      .bind(customerId, limit)
      .all<SupportTicketRow>();
    return res.results;
  },

  prepareCreateIfNoActiveTicket(
    db: D1Database,
    params: {
      ticketId: string;
      customerId: string;
      ticketType: TicketType;
      slipCount?: number;
      latestSlipId?: string | null;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO support_tickets (
          ticket_id, customer_id, ticket_type, status, assigned_admin_id,
          reminder_sent, escalated, slip_count, latest_slip_id,
          version, last_mutation_token, created_at, updated_at
        ) SELECT ?1, ?2, ?3, 'OPEN', NULL, 0, 0, ?4, ?5, 1, ?6, ?7, ?7
        WHERE EXISTS (
          SELECT 1 FROM customers WHERE telegram_user_id = ?2 AND account_status = 'ACTIVE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM support_tickets WHERE customer_id = ?2 AND status IN ('OPEN', 'ASSIGNED')
        )`
      )
      .bind(
        params.ticketId,
        params.customerId,
        params.ticketType,
        params.slipCount ?? 0,
        params.latestSlipId ?? null,
        params.mutationToken,
        params.nowMs
      );
  },

  prepareAtomicClaim(
    db: D1Database,
    params: {
      ticketId: string;
      adminId: string;
      expectedVersion?: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    if (params.expectedVersion !== undefined) {
      return db
        .prepare(
          `UPDATE support_tickets
           SET status = 'ASSIGNED',
               assigned_admin_id = ?2,
               assigned_at = ?3,
               last_admin_activity_at = ?3,
               reminder_sent = 0,
               escalated = 0,
               version = version + 1,
               last_mutation_token = ?4,
               updated_at = ?3
           WHERE ticket_id = ?1
             AND status = 'OPEN'
             AND assigned_admin_id IS NULL
             AND version = ?5
             AND EXISTS (
               SELECT 1 FROM admins
               WHERE telegram_user_id = ?2
                 AND is_active = 1
                 AND has_started_bot = 1
                 AND (role = 'SUPER_ADMIN' OR instr(permissions_json, '"ticket.claim"') > 0)
             )
           RETURNING *`
        )
        .bind(params.ticketId, params.adminId, params.nowMs, params.mutationToken, params.expectedVersion);
    }

    return db
      .prepare(
        `UPDATE support_tickets
         SET status = 'ASSIGNED',
             assigned_admin_id = ?2,
             assigned_at = ?3,
             last_admin_activity_at = ?3,
             reminder_sent = 0,
             escalated = 0,
             version = version + 1,
             last_mutation_token = ?4,
             updated_at = ?3
         WHERE ticket_id = ?1
           AND status = 'OPEN'
           AND assigned_admin_id IS NULL
           AND EXISTS (
             SELECT 1 FROM admins
             WHERE telegram_user_id = ?2
               AND is_active = 1
               AND has_started_bot = 1
               AND (role = 'SUPER_ADMIN' OR instr(permissions_json, '"ticket.claim"') > 0)
           )
         RETURNING *`
      )
      .bind(params.ticketId, params.adminId, params.nowMs, params.mutationToken);
  },

  prepareAtomicRelease(
    db: D1Database,
    params: {
      ticketId: string;
      actorAdminId: string;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE support_tickets
         SET status = 'OPEN',
             assigned_admin_id = NULL,
             assigned_at = NULL,
             last_admin_activity_at = NULL,
             reminder_sent = 0,
             escalated = 0,
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?4
         WHERE ticket_id = ?1
           AND status = 'ASSIGNED'
           AND (
             assigned_admin_id = ?2
             OR EXISTS (SELECT 1 FROM admins WHERE telegram_user_id = ?2 AND is_active = 1 AND role = 'SUPER_ADMIN')
           )
         RETURNING *`
      )
      .bind(params.ticketId, params.actorAdminId, params.mutationToken, params.nowMs);
  },

  prepareAtomicResolve(
    db: D1Database,
    params: {
      ticketId: string;
      actorAdminId: string;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE support_tickets
         SET status = 'RESOLVED',
             resolved_by_admin_id = ?2,
             resolved_at = ?4,
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?4
         WHERE ticket_id = ?1
           AND status IN ('OPEN', 'ASSIGNED')
           AND (
             assigned_admin_id = ?2
             OR EXISTS (SELECT 1 FROM admins WHERE telegram_user_id = ?2 AND is_active = 1 AND role = 'SUPER_ADMIN')
           )
         RETURNING *`
      )
      .bind(params.ticketId, params.actorAdminId, params.mutationToken, params.nowMs);
  },

  prepareTouchAdminActivity(
    db: D1Database,
    ticketId: string,
    adminId: string,
    mutationToken: string,
    nowMs: number
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE support_tickets
         SET last_admin_activity_at = ?3,
             reminder_sent = 0,
             escalated = 0,
             version = version + 1,
             last_mutation_token = ?4,
             updated_at = ?3
         WHERE ticket_id = ?1
           AND status = 'ASSIGNED'
           AND assigned_admin_id = ?2
         RETURNING *`
      )
      .bind(ticketId, adminId, nowMs, mutationToken);
  },

  async findIdleReminderCandidates(db: D1Database, cutoffMs: number, limit = 20): Promise<SupportTicketRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM support_tickets
         WHERE status = 'ASSIGNED'
           AND reminder_sent = 0
           AND last_admin_activity_at <= ?1
         ORDER BY last_admin_activity_at ASC
         LIMIT ?2`
      )
      .bind(cutoffMs, limit)
      .all<SupportTicketRow>();
    return res.results;
  },

  async findIdleEscalationCandidates(db: D1Database, cutoffMs: number, limit = 20): Promise<SupportTicketRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM support_tickets
         WHERE status = 'ASSIGNED'
           AND escalated = 0
           AND last_admin_activity_at <= ?1
         ORDER BY last_admin_activity_at ASC
         LIMIT ?2`
      )
      .bind(cutoffMs, limit)
      .all<SupportTicketRow>();
    return res.results;
  },

  async listOpenTickets(db: D1Database, limit = 15): Promise<SupportTicketRow[]> {
    const res = await db
      .prepare(`SELECT * FROM support_tickets WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT ?1`)
      .bind(limit)
      .all<SupportTicketRow>();
    return res.results;
  },

  async listAssignedToAdmin(db: D1Database, adminId: string, limit = 15): Promise<SupportTicketRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM support_tickets
         WHERE status = 'ASSIGNED' AND assigned_admin_id = ?1
         ORDER BY updated_at DESC LIMIT ?2`
      )
      .bind(adminId, limit)
      .all<SupportTicketRow>();
    return res.results;
  },
};
