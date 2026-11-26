import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { MessageRow } from '../types/domain';
import { ValidationError } from '../lib/errors';

function assertStrictCustomerId(customerId: string): void {
  if (!customerId || !/^\d{1,20}$/.test(customerId)) {
    throw new ValidationError('MESSAGE_REPO_STRICT_CUSTOMER_ID_REQUIRED');
  }
}

export const messageRepository = {
  async getRecentForAiContext(
    db: D1Database,
    customerId: string,
    maxMessages = 15
  ): Promise<MessageRow[]> {
    assertStrictCustomerId(customerId);
    const boundedLimit = Math.min(Math.max(1, maxMessages), 15);
    const res = await db
      .prepare(
        `SELECT * FROM messages
         WHERE customer_id = ?1
           AND include_in_ai_context = 1
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?2`
      )
      .bind(customerId, boundedLimit)
      .all<MessageRow>();

    // Reverse in memory so messages are ordered chronologically oldest -> newest
    return [...res.results].reverse();
  },

  async countRecentInboundMessages(
    db: D1Database,
    customerId: string,
    sinceUtcMs: number
  ): Promise<number> {
    assertStrictCustomerId(customerId);
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM messages
         WHERE customer_id = ?1
           AND direction = 'INBOUND'
           AND created_at >= ?2`
      )
      .bind(customerId, sinceUtcMs)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  },

  prepareInsertMessage(
    db: D1Database,
    msg: {
      messageId: string;
      customerId: string;
      telegramMessageId?: number | null;
      updateId?: number | null;
      ticketId?: string | null;
      direction: 'INBOUND' | 'OUTBOUND';
      senderRole: 'USER' | 'MODEL' | 'ADMIN' | 'SYSTEM';
      senderId: string;
      messageType: 'TEXT' | 'PHOTO' | 'SYSTEM';
      textContent?: string | null;
      mediaFileId?: string | null;
      mediaFileUniqueId?: string | null;
      isPotentialSlip: boolean;
      deliveryStatus: 'RECEIVED' | 'PENDING' | 'SENT' | 'DELIVERY_UNCERTAIN' | 'PERMANENT_FAILURE';
      createdAt: number;
      gateCustomerMode?: 'AI' | 'HUMAN';
      gateTable?: string;
      gatePkColumn?: string;
      gatePkValue?: string;
      gateMutationToken?: string;
    }
  ): D1PreparedStatement {
    assertStrictCustomerId(msg.customerId);
    const includeInAiContext =
      ['USER', 'MODEL', 'ADMIN'].includes(msg.senderRole) &&
      msg.messageType === 'TEXT' &&
      !msg.isPotentialSlip
        ? 1
        : 0;

    if (msg.gateTable && msg.gatePkColumn && msg.gatePkValue && msg.gateMutationToken) {
      return db
        .prepare(
          `INSERT INTO messages (
            message_id, customer_id, telegram_message_id, update_id, ticket_id,
            direction, sender_role, sender_id, message_type, text_content,
            media_file_id, media_file_unique_id, is_potential_slip,
            include_in_ai_context, delivery_status, created_at
          ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
          WHERE EXISTS (
            SELECT 1 FROM ${msg.gateTable}
            WHERE ${msg.gatePkColumn} = ?17 AND last_mutation_token = ?18
          )`
        )
        .bind(
          msg.messageId,
          msg.customerId,
          msg.telegramMessageId ?? null,
          msg.updateId ?? null,
          msg.ticketId ?? null,
          msg.direction,
          msg.senderRole,
          msg.senderId,
          msg.messageType,
          msg.textContent ?? null,
          msg.mediaFileId ?? null,
          msg.mediaFileUniqueId ?? null,
          msg.isPotentialSlip ? 1 : 0,
          includeInAiContext,
          msg.deliveryStatus,
          msg.createdAt,
          msg.gatePkValue,
          msg.gateMutationToken
        );
    }

    if (msg.gateCustomerMode) {
      return db
        .prepare(
          `INSERT INTO messages (
            message_id, customer_id, telegram_message_id, update_id, ticket_id,
            direction, sender_role, sender_id, message_type, text_content,
            media_file_id, media_file_unique_id, is_potential_slip,
            include_in_ai_context, delivery_status, created_at
          ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
          WHERE EXISTS (
            SELECT 1 FROM customers
            WHERE telegram_user_id = ?2
              AND account_status = 'ACTIVE'
              AND chat_mode = ?17
          )`
        )
        .bind(
          msg.messageId,
          msg.customerId,
          msg.telegramMessageId ?? null,
          msg.updateId ?? null,
          msg.ticketId ?? null,
          msg.direction,
          msg.senderRole,
          msg.senderId,
          msg.messageType,
          msg.textContent ?? null,
          msg.mediaFileId ?? null,
          msg.mediaFileUniqueId ?? null,
          msg.isPotentialSlip ? 1 : 0,
          includeInAiContext,
          msg.deliveryStatus,
          msg.createdAt,
          msg.gateCustomerMode
        );
    }

    return db
      .prepare(
        `INSERT INTO messages (
          message_id, customer_id, telegram_message_id, update_id, ticket_id,
          direction, sender_role, sender_id, message_type, text_content,
          media_file_id, media_file_unique_id, is_potential_slip,
          include_in_ai_context, delivery_status, created_at
        ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
        WHERE EXISTS (
          SELECT 1 FROM customers
          WHERE telegram_user_id = ?2 AND account_status = 'ACTIVE'
        )`
      )
      .bind(
        msg.messageId,
        msg.customerId,
        msg.telegramMessageId ?? null,
        msg.updateId ?? null,
        msg.ticketId ?? null,
        msg.direction,
        msg.senderRole,
        msg.senderId,
        msg.messageType,
        msg.textContent ?? null,
        msg.mediaFileId ?? null,
        msg.mediaFileUniqueId ?? null,
        msg.isPotentialSlip ? 1 : 0,
        includeInAiContext,
        msg.deliveryStatus,
        msg.createdAt
      );
  },
};
