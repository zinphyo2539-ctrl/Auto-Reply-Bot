import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { AdminRole, AdminRow, AdminSessionRow } from '../types/domain';

export const adminRepository = {
  async getById(db: D1Database, telegramUserId: string): Promise<AdminRow | null> {
    if (!telegramUserId || !/^\d{1,20}$/.test(telegramUserId)) {
      return null;
    }
    return db
      .prepare('SELECT * FROM admins WHERE telegram_user_id = ?1')
      .bind(telegramUserId)
      .first<AdminRow>();
  },

  async getActiveAdmin(db: D1Database, telegramUserId: string): Promise<AdminRow | null> {
    if (!telegramUserId || !/^\d{1,20}$/.test(telegramUserId)) {
      return null;
    }
    return db
      .prepare('SELECT * FROM admins WHERE telegram_user_id = ?1 AND is_active = 1')
      .bind(telegramUserId)
      .first<AdminRow>();
  },

  hasPermission(admin: AdminRow, permission: string): boolean {
    if (admin.is_active !== 1) {
      return false;
    }
    if (admin.role === 'SUPER_ADMIN') {
      return true;
    }
    try {
      const perms = JSON.parse(admin.permissions_json) as string[];
      return Array.isArray(perms) && perms.includes(permission);
    } catch {
      return false;
    }
  },

  async upsertBootstrapSuperAdmin(
    db: D1Database,
    telegramUserId: string,
    displayName: string,
    mutationToken: string,
    nowMs: number
  ): Promise<AdminRow> {
    const allPerms = JSON.stringify([
      'ticket.view',
      'ticket.claim',
      'ticket.reply',
      'ticket.resolve',
      'slip.review',
      'deposit.review',
      'withdrawal.review',
      'customer.ban',
      'config.manage',
      'admin.manage',
    ]);
    const row = await db
      .prepare(
        `INSERT INTO admins (
          telegram_user_id, role, is_active, has_started_bot,
          permissions_json, display_name, last_seen_at,
          version, last_mutation_token, created_at, updated_at
        ) VALUES (?1, 'SUPER_ADMIN', 1, 1, ?2, ?3, ?4, 1, ?5, ?4, ?4)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          has_started_bot = 1,
          last_seen_at = ?4,
          version = admins.version + 1,
          last_mutation_token = ?5,
          updated_at = ?4
        RETURNING *`
      )
      .bind(telegramUserId, allPerms, displayName.slice(0, 128), nowMs, mutationToken)
      .first<AdminRow>();

    if (!row) {
      throw new Error('BOOTSTRAP_SUPER_ADMIN_UPSERT_FAILED');
    }
    return row;
  },

  async markBotStarted(
    db: D1Database,
    telegramUserId: string,
    mutationToken: string,
    nowMs: number
  ): Promise<AdminRow | null> {
    return db
      .prepare(
        `UPDATE admins
         SET has_started_bot = 1,
             last_seen_at = ?2,
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?2
         WHERE telegram_user_id = ?1 AND is_active = 1
         RETURNING *`
      )
      .bind(telegramUserId, nowMs, mutationToken)
      .first<AdminRow>();
  },

  prepareUpsertAdmin(
    db: D1Database,
    params: {
      targetAdminId: string;
      role: AdminRole;
      isActive: boolean;
      permissions: string[];
      displayName: string;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO admins (
          telegram_user_id, role, is_active, has_started_bot,
          permissions_json, display_name, last_seen_at,
          version, last_mutation_token, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 0, ?4, ?5, NULL, 1, ?6, ?7, ?7)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          role = excluded.role,
          is_active = excluded.is_active,
          permissions_json = excluded.permissions_json,
          display_name = excluded.display_name,
          version = admins.version + 1,
          last_mutation_token = ?6,
          updated_at = ?7
        RETURNING *`
      )
      .bind(
        params.targetAdminId,
        params.role,
        params.isActive ? 1 : 0,
        JSON.stringify(params.permissions),
        params.displayName.slice(0, 128),
        params.mutationToken,
        params.nowMs
      );
  },

  prepareAutoReleaseTicketsOnDeactivation(
    db: D1Database,
    targetAdminId: string,
    mutationToken: string,
    nowMs: number
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
             last_mutation_token = ?2,
             updated_at = ?3
         WHERE status = 'ASSIGNED'
           AND assigned_admin_id = ?1
           AND EXISTS (
             SELECT 1 FROM admins
             WHERE telegram_user_id = ?1 AND is_active = 0 AND last_mutation_token = ?2
           )`
      )
      .bind(targetAdminId, mutationToken, nowMs);
  },

  async getSession(db: D1Database, adminId: string): Promise<AdminSessionRow | null> {
    return db
      .prepare('SELECT * FROM admin_sessions WHERE admin_id = ?1')
      .bind(adminId)
      .first<AdminSessionRow>();
  },

  prepareUpsertSession(
    db: D1Database,
    params: {
      adminId: string;
      sessionState: AdminSessionRow['session_state'];
      targetCustomerId?: string | null;
      targetTicketId?: string | null;
      targetSlipId?: string | null;
      targetDepositId?: string | null;
      targetWithdrawalId?: string | null;
      pendingDecision?: string | null;
      targetExpectedVersion?: number | null;
      nowMs: number;
      gateTable?: string;
      gatePkColumn?: string;
      gatePkValue?: string;
      gateMutationToken?: string;
    }
  ): D1PreparedStatement {
    const expiresAt = params.nowMs + 30 * 60 * 1000;

    if (params.gateTable && params.gatePkColumn && params.gatePkValue && params.gateMutationToken) {
      return db
        .prepare(
          `INSERT INTO admin_sessions (
            admin_id, session_state, target_customer_id, target_ticket_id,
            target_slip_id, target_deposit_id, target_withdrawal_id,
            pending_decision, target_expected_version, expires_at, updated_at
          ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
          WHERE EXISTS (
            SELECT 1 FROM ${params.gateTable}
            WHERE ${params.gatePkColumn} = ?12 AND last_mutation_token = ?13
          )
          ON CONFLICT(admin_id) DO UPDATE SET
            session_state = excluded.session_state,
            target_customer_id = excluded.target_customer_id,
            target_ticket_id = excluded.target_ticket_id,
            target_slip_id = excluded.target_slip_id,
            target_deposit_id = excluded.target_deposit_id,
            target_withdrawal_id = excluded.target_withdrawal_id,
            pending_decision = excluded.pending_decision,
            target_expected_version = excluded.target_expected_version,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`
        )
        .bind(
          params.adminId,
          params.sessionState,
          params.targetCustomerId ?? null,
          params.targetTicketId ?? null,
          params.targetSlipId ?? null,
          params.targetDepositId ?? null,
          params.targetWithdrawalId ?? null,
          params.pendingDecision ?? null,
          params.targetExpectedVersion ?? null,
          expiresAt,
          params.nowMs,
          params.gatePkValue,
          params.gateMutationToken
        );
    }

    return db
      .prepare(
        `INSERT INTO admin_sessions (
          admin_id, session_state, target_customer_id, target_ticket_id,
          target_slip_id, target_deposit_id, target_withdrawal_id,
          pending_decision, target_expected_version, expires_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(admin_id) DO UPDATE SET
          session_state = excluded.session_state,
          target_customer_id = excluded.target_customer_id,
          target_ticket_id = excluded.target_ticket_id,
          target_slip_id = excluded.target_slip_id,
          target_deposit_id = excluded.target_deposit_id,
          target_withdrawal_id = excluded.target_withdrawal_id,
          pending_decision = excluded.pending_decision,
          target_expected_version = excluded.target_expected_version,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        params.adminId,
        params.sessionState,
        params.targetCustomerId ?? null,
        params.targetTicketId ?? null,
        params.targetSlipId ?? null,
        params.targetDepositId ?? null,
        params.targetWithdrawalId ?? null,
        params.pendingDecision ?? null,
        params.targetExpectedVersion ?? null,
        expiresAt,
        params.nowMs
      );
  },

  prepareClearSession(db: D1Database, adminId: string): D1PreparedStatement {
    return db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?1').bind(adminId);
  },

  async listActiveSuperAdmins(db: D1Database): Promise<AdminRow[]> {
    const res = await db
      .prepare(`SELECT * FROM admins WHERE role = 'SUPER_ADMIN' AND is_active = 1 AND has_started_bot = 1`)
      .all<AdminRow>();
    return res.results;
  },
};
