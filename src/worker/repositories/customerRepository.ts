import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { CustomerRow, CustomerSessionRow, LanguageCode } from '../types/domain';
import { ValidationError } from '../lib/errors';

function assertValidCustomerId(customerId: string): void {
  if (!customerId || !/^\d{1,20}$/.test(customerId)) {
    throw new ValidationError(`Invalid customer Telegram User ID: ${customerId}`);
  }
}

export const customerRepository = {
  async getById(db: D1Database, customerId: string): Promise<CustomerRow | null> {
    assertValidCustomerId(customerId);
    return db
      .prepare('SELECT * FROM customers WHERE telegram_user_id = ?1')
      .bind(customerId)
      .first<CustomerRow>();
  },

  prepareUpsertActiveCustomer(
    db: D1Database,
    params: {
      customerId: string;
      username: string | null;
      firstName: string;
      languageCode?: LanguageCode;
      forceHumanMode?: boolean;
      incrementUnread?: boolean;
      messagePreview?: string | null;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    assertValidCustomerId(params.customerId);
    const initialMode = params.forceHumanMode ? 'HUMAN' : 'AI';
    const initialUnread = params.incrementUnread ? 1 : 0;

    return db
      .prepare(
        `INSERT INTO customers (
          telegram_user_id, username, first_name, language_code, chat_mode, account_status,
          mode_changed_at, unread_count, last_message_preview, last_interaction_at,
          version, last_mutation_token, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'ACTIVE', ?6, ?7, ?8, ?6, 1, ?9, ?6, ?6)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          chat_mode = CASE WHEN ?10 = 1 THEN 'HUMAN' ELSE customers.chat_mode END,
          mode_changed_at = CASE WHEN ?10 = 1 AND customers.chat_mode != 'HUMAN' THEN ?6 ELSE customers.mode_changed_at END,
          unread_count = CASE WHEN ?11 = 1 THEN customers.unread_count + 1 ELSE customers.unread_count END,
          last_message_preview = COALESCE(?8, customers.last_message_preview),
          last_interaction_at = ?6,
          version = customers.version + 1,
          last_mutation_token = ?9,
          updated_at = ?6
        WHERE customers.account_status = 'ACTIVE'`
      )
      .bind(
        params.customerId,
        params.username,
        params.firstName.slice(0, 128),
        params.languageCode ?? 'my',
        initialMode,
        params.nowMs,
        initialUnread,
        params.messagePreview ? params.messagePreview.slice(0, 120) : null,
        params.mutationToken,
        params.forceHumanMode ? 1 : 0,
        params.incrementUnread ? 1 : 0
      );
  },

  prepareExplicitReturnToAi(
    db: D1Database,
    params: {
      customerId: string;
      mutationToken: string;
      nowMs: number;
      gateTable?: string;
      gatePkColumn?: string;
      gatePkValue?: string;
    }
  ): D1PreparedStatement {
    assertValidCustomerId(params.customerId);
    if (params.gateTable && params.gatePkColumn && params.gatePkValue) {
      return db
        .prepare(
          `UPDATE customers
           SET chat_mode = 'AI',
               mode_changed_at = ?2,
               unread_count = 0,
               version = version + 1,
               last_mutation_token = ?3,
               updated_at = ?2
           WHERE telegram_user_id = ?1
             AND EXISTS (
               SELECT 1 FROM ${params.gateTable}
               WHERE ${params.gatePkColumn} = ?4 AND last_mutation_token = ?3
             )`
        )
        .bind(params.customerId, params.nowMs, params.mutationToken, params.gatePkValue);
    }

    return db
      .prepare(
        `UPDATE customers
         SET chat_mode = 'AI',
             mode_changed_at = ?2,
             unread_count = 0,
             version = version + 1,
             last_mutation_token = ?3,
             updated_at = ?2
         WHERE telegram_user_id = ?1`
      )
      .bind(params.customerId, params.nowMs, params.mutationToken);
  },

  async getSession(db: D1Database, customerId: string): Promise<CustomerSessionRow | null> {
    assertValidCustomerId(customerId);
    return db
      .prepare('SELECT * FROM customer_sessions WHERE customer_id = ?1')
      .bind(customerId)
      .first<CustomerSessionRow>();
  },

  async upsertSession(
    db: D1Database,
    session: Omit<CustomerSessionRow, 'wizard_version'> & { expectedVersion?: number }
  ): Promise<boolean> {
    assertValidCustomerId(session.customer_id);
    if (session.expectedVersion !== undefined) {
      const res = await db
        .prepare(
          `UPDATE customer_sessions
           SET wizard_type = ?2,
               wizard_state = ?3,
               draft_token = ?4,
               draft_amount = ?5,
               draft_method_code = ?6,
               draft_reference_text = ?7,
               draft_dest_masked = ?8,
               draft_dest_ciphertext = ?9,
               draft_dest_iv = ?10,
               key_version = ?11,
               target_request_type = ?12,
               target_request_id = ?13,
               wizard_version = wizard_version + 1,
               updated_at = ?14
           WHERE customer_id = ?1
             AND wizard_version = ?15
             AND expires_at > ?14`
        )
        .bind(
          session.customer_id,
          session.wizard_type,
          session.wizard_state,
          session.draft_token,
          session.draft_amount,
          session.draft_method_code,
          session.draft_reference_text,
          session.draft_dest_masked,
          session.draft_dest_ciphertext,
          session.draft_dest_iv,
          session.key_version,
          session.target_request_type,
          session.target_request_id,
          session.updated_at,
          session.expectedVersion
        )
        .run();
      return res.meta.changes === 1;
    }

    await db
      .prepare(
        `INSERT INTO customer_sessions (
          customer_id, wizard_type, wizard_state, draft_token,
          draft_amount, draft_method_code, draft_reference_text,
          draft_dest_masked, draft_dest_ciphertext, draft_dest_iv,
          key_version, target_request_type, target_request_id,
          wizard_version, started_at, expires_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?15, ?16)
        ON CONFLICT(customer_id) DO UPDATE SET
          wizard_type = excluded.wizard_type,
          wizard_state = excluded.wizard_state,
          draft_token = excluded.draft_token,
          draft_amount = excluded.draft_amount,
          draft_method_code = excluded.draft_method_code,
          draft_reference_text = excluded.draft_reference_text,
          draft_dest_masked = excluded.draft_dest_masked,
          draft_dest_ciphertext = excluded.draft_dest_ciphertext,
          draft_dest_iv = excluded.draft_dest_iv,
          key_version = excluded.key_version,
          target_request_type = excluded.target_request_type,
          target_request_id = excluded.target_request_id,
          wizard_version = customer_sessions.wizard_version + 1,
          started_at = excluded.started_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`
      )
      .bind(
        session.customer_id,
        session.wizard_type,
        session.wizard_state,
        session.draft_token,
        session.draft_amount,
        session.draft_method_code,
        session.draft_reference_text,
        session.draft_dest_masked,
        session.draft_dest_ciphertext,
        session.draft_dest_iv,
        session.key_version,
        session.target_request_type,
        session.target_request_id,
        session.started_at,
        session.expires_at,
        session.updated_at
      )
      .run();
    return true;
  },

  async clearSession(db: D1Database, customerId: string): Promise<void> {
    assertValidCustomerId(customerId);
    await db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?1').bind(customerId).run();
  },

  async listHumanInbox(db: D1Database, limit = 15): Promise<CustomerRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM customers
         WHERE chat_mode = 'HUMAN' AND account_status = 'ACTIVE'
         ORDER BY last_interaction_at DESC LIMIT ?1`
      )
      .bind(limit)
      .all<CustomerRow>();
    return res.results;
  },
};
