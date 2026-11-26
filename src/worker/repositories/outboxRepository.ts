import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { OutboxRow } from '../types/domain';

export interface EnqueueOutboxSpec {
  outboxId: string;
  idempotencyKey: string;
  eventType: string;
  aggregateType: OutboxRow['aggregate_type'];
  aggregateId: string;
  targetChatId: string;
  orderingKey?: string;
  sequenceNo?: number;
  telegramMethod: OutboxRow['telegram_method'];
  payload: Record<string, unknown>;
  relatedMessageId?: string | null;
  relatedTicketId?: string | null;
  availableAt: number;
  nowMs: number;
  gateCondition?: {
    table: string;
    pkColumn: string;
    pkValue: string;
    mutationToken: string;
    extraWhereSql?: string;
  };
}

export const outboxRepository = {
  prepareEnqueue(db: D1Database, spec: EnqueueOutboxSpec): D1PreparedStatement {
    const isIdempotent = spec.telegramMethod === 'editMessageText' ? 1 : 0;
    const orderingKey = spec.orderingKey ?? spec.targetChatId;
    const sequenceNo = spec.sequenceNo ?? 1;
    const payloadJson = JSON.stringify(spec.payload);
    const nextDispatchAt = spec.availableAt + 15000;

    if (spec.gateCondition) {
      const extraClause = spec.gateCondition.extraWhereSql ? ` AND ${spec.gateCondition.extraWhereSql}` : '';
      return db
        .prepare(
          `INSERT INTO outbox (
            outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id,
            target_chat_id, ordering_key, sequence_no, telegram_method, payload_json,
            is_idempotent_method, related_message_id, related_ticket_id,
            status, attempt_count, max_attempts, available_at, next_dispatch_at,
            created_at, updated_at
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 'PENDING', 0, 6, ?14, ?15, ?16, ?16
          WHERE EXISTS (
            SELECT 1 FROM ${spec.gateCondition.table}
            WHERE ${spec.gateCondition.pkColumn} = ?17
              AND last_mutation_token = ?18${extraClause}
          )
          ON CONFLICT(idempotency_key) DO NOTHING
          RETURNING outbox_id`
        )
        .bind(
          spec.outboxId,
          spec.idempotencyKey,
          spec.eventType,
          spec.aggregateType,
          spec.aggregateId,
          spec.targetChatId,
          orderingKey,
          sequenceNo,
          spec.telegramMethod,
          payloadJson,
          isIdempotent,
          spec.relatedMessageId ?? null,
          spec.relatedTicketId ?? null,
          spec.availableAt,
          nextDispatchAt,
          spec.nowMs,
          spec.gateCondition.pkValue,
          spec.gateCondition.mutationToken
        );
    }

    return db
      .prepare(
        `INSERT INTO outbox (
          outbox_id, idempotency_key, event_type, aggregate_type, aggregate_id,
          target_chat_id, ordering_key, sequence_no, telegram_method, payload_json,
          is_idempotent_method, related_message_id, related_ticket_id,
          status, attempt_count, max_attempts, available_at, next_dispatch_at,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          'PENDING', 0, 6, ?14, ?15, ?16, ?16
        )
        ON CONFLICT(idempotency_key) DO NOTHING
        RETURNING outbox_id`
      )
      .bind(
        spec.outboxId,
        spec.idempotencyKey,
        spec.eventType,
        spec.aggregateType,
        spec.aggregateId,
        spec.targetChatId,
        orderingKey,
        sequenceNo,
        spec.telegramMethod,
        payloadJson,
        isIdempotent,
        spec.relatedMessageId ?? null,
        spec.relatedTicketId ?? null,
        spec.availableAt,
        nextDispatchAt,
        spec.nowMs
      );
  },

  async claimForConsumer(
    db: D1Database,
    params: {
      outboxId: string;
      leaseOwner: string;
      leaseToken: string;
      nowMs: number;
      leaseDurationMs?: number;
    }
  ): Promise<OutboxRow | null> {
    const leaseExpiresAt = params.nowMs + (params.leaseDurationMs ?? 30000);
    return db
      .prepare(
        `UPDATE outbox
         SET status = 'CLAIMED',
             lease_owner = ?2,
             lease_token = ?3,
             lease_expires_at = ?4,
             attempt_count = attempt_count + 1,
             updated_at = ?5
         WHERE outbox_id = ?1
           AND status IN ('PENDING', 'RETRYABLE_FAILURE')
           AND available_at <= ?5
           AND NOT EXISTS (
             SELECT 1 FROM outbox prev
             WHERE prev.ordering_key = outbox.ordering_key
               AND prev.outbox_id != outbox.outbox_id
               AND prev.status IN ('PENDING', 'CLAIMED', 'SENDING', 'RETRYABLE_FAILURE')
               AND (
                 prev.created_at < outbox.created_at
                 OR (prev.created_at = outbox.created_at AND prev.sequence_no < outbox.sequence_no)
               )
           )
         RETURNING *`
      )
      .bind(params.outboxId, params.leaseOwner, params.leaseToken, leaseExpiresAt, params.nowMs)
      .first<OutboxRow>();
  },

  async markSending(
    db: D1Database,
    outboxId: string,
    leaseToken: string,
    nowMs: number
  ): Promise<boolean> {
    const res = await db
      .prepare(
        `UPDATE outbox
         SET status = 'SENDING',
             lease_expires_at = (?3 + 25000),
             updated_at = ?3
         WHERE outbox_id = ?1
           AND status = 'CLAIMED'
           AND lease_token = ?2`
      )
      .bind(outboxId, leaseToken, nowMs)
      .run();
    return res.meta.changes === 1;
  },

  async markSent(
    db: D1Database,
    params: {
      outbox: OutboxRow;
      leaseToken: string;
      telegramMessageId: number | null;
      nowMs: number;
    }
  ): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE outbox
           SET status = 'SENT',
               telegram_message_id = ?3,
               sent_at = ?4,
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = ?4
           WHERE outbox_id = ?1 AND lease_token = ?2`
        )
        .bind(params.outbox.outbox_id, params.leaseToken, params.telegramMessageId, params.nowMs),
    ];

    if (params.outbox.related_message_id) {
      stmts.push(
        db
          .prepare(
            `UPDATE messages
             SET delivery_status = 'SENT',
                 telegram_message_id = COALESCE(?2, telegram_message_id)
             WHERE message_id = ?1`
          )
          .bind(params.outbox.related_message_id, params.telegramMessageId)
      );
    }

    if (
      params.outbox.related_ticket_id &&
      params.outbox.event_type === 'GROUP_ALERT' &&
      params.telegramMessageId !== null
    ) {
      stmts.push(
        db
          .prepare(
            `UPDATE support_tickets
             SET group_notification_msg_id = ?2
             WHERE ticket_id = ?1`
          )
          .bind(params.outbox.related_ticket_id, params.telegramMessageId)
      );
    }

    await db.batch(stmts);
  },

  async markRetryableFailure(
    db: D1Database,
    params: {
      outbox: OutboxRow;
      leaseToken: string;
      nextAvailableAt: number;
      errorMsg: string;
      nowMs: number;
    }
  ): Promise<void> {
    if (params.outbox.attempt_count >= params.outbox.max_attempts) {
      await this.markPermanentFailure(db, {
        outbox: params.outbox,
        leaseToken: params.leaseToken,
        errorMsg: `MAX_ATTEMPTS_EXHAUSTED: ${params.errorMsg}`,
        nowMs: params.nowMs,
      });
      return;
    }

    await db
      .prepare(
        `UPDATE outbox
         SET status = 'RETRYABLE_FAILURE',
             available_at = ?3,
             next_dispatch_at = ?3,
             last_error = ?4,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?5
         WHERE outbox_id = ?1 AND lease_token = ?2`
      )
      .bind(
        params.outbox.outbox_id,
        params.leaseToken,
        params.nextAvailableAt,
        params.errorMsg.slice(0, 500),
        params.nowMs
      )
      .run();
  },

  async markDeliveryUncertain(
    db: D1Database,
    params: {
      outbox: OutboxRow;
      leaseToken?: string | null;
      errorMsg: string;
      nowMs: number;
    }
  ): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      params.leaseToken
        ? db
            .prepare(
              `UPDATE outbox
               SET status = 'DELIVERY_UNCERTAIN',
                   delivery_uncertain_at = ?3,
                   last_error = ?4,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = ?3
               WHERE outbox_id = ?1 AND lease_token = ?2`
            )
            .bind(
              params.outbox.outbox_id,
              params.leaseToken,
              params.nowMs,
              params.errorMsg.slice(0, 500)
            )
        : db
            .prepare(
              `UPDATE outbox
               SET status = 'DELIVERY_UNCERTAIN',
                   delivery_uncertain_at = ?2,
                   last_error = ?3,
                   lease_owner = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   updated_at = ?2
               WHERE outbox_id = ?1 AND status = 'SENDING'`
            )
            .bind(params.outbox.outbox_id, params.nowMs, params.errorMsg.slice(0, 500)),
    ];

    if (params.outbox.related_message_id) {
      stmts.push(
        db
          .prepare(`UPDATE messages SET delivery_status = 'DELIVERY_UNCERTAIN' WHERE message_id = ?1`)
          .bind(params.outbox.related_message_id)
      );
    }

    await db.batch(stmts);
  },

  async markPermanentFailure(
    db: D1Database,
    params: {
      outbox: OutboxRow;
      leaseToken: string;
      errorMsg: string;
      nowMs: number;
    }
  ): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE outbox
           SET status = 'PERMANENT_FAILURE',
               last_error = ?3,
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = ?4
           WHERE outbox_id = ?1 AND lease_token = ?2`
        )
        .bind(params.outbox.outbox_id, params.leaseToken, params.errorMsg.slice(0, 500), params.nowMs),
    ];

    if (params.outbox.related_message_id) {
      stmts.push(
        db
          .prepare(`UPDATE messages SET delivery_status = 'PERMANENT_FAILURE' WHERE message_id = ?1`)
          .bind(params.outbox.related_message_id)
      );
    }

    await db.batch(stmts);
  },

  async claimDueForCronDispatch(db: D1Database, nowMs: number, limit = 20): Promise<OutboxRow[]> {
    const candidates = await db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('PENDING', 'RETRYABLE_FAILURE')
           AND available_at <= ?1
           AND next_dispatch_at <= ?1
         ORDER BY available_at ASC
         LIMIT ?2`
      )
      .bind(nowMs, limit)
      .all<OutboxRow>();

    const claimed: OutboxRow[] = [];
    for (const row of candidates.results) {
      const bumped = await db
        .prepare(
          `UPDATE outbox
           SET next_dispatch_at = (?2 + 60000),
               updated_at = ?2
           WHERE outbox_id = ?1
             AND status IN ('PENDING', 'RETRYABLE_FAILURE')
             AND available_at <= ?2
             AND next_dispatch_at <= ?2
           RETURNING *`
        )
        .bind(row.outbox_id, nowMs)
        .first<OutboxRow>();
      if (bumped) {
        claimed.push(bumped);
      }
    }
    return claimed;
  },

  async findExpiredActiveLeases(db: D1Database, nowMs: number, limit = 20): Promise<OutboxRow[]> {
    const res = await db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('CLAIMED', 'SENDING')
           AND lease_expires_at <= ?1
         ORDER BY lease_expires_at ASC
         LIMIT ?2`
      )
      .bind(nowMs, limit)
      .all<OutboxRow>();
    return res.results;
  },

  async recoverExpiredClaimedRow(db: D1Database, outboxId: string, nowMs: number): Promise<boolean> {
    const res = await db
      .prepare(
        `UPDATE outbox
         SET status = 'RETRYABLE_FAILURE',
             available_at = ?2,
             next_dispatch_at = ?2,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error = 'RECOVERED_EXPIRED_CLAIMED_PRE_NETWORK',
             updated_at = ?2
         WHERE outbox_id = ?1
           AND status = 'CLAIMED'
           AND lease_expires_at <= ?2`
      )
      .bind(outboxId, nowMs)
      .run();
    return res.meta.changes === 1;
  },

  async getById(db: D1Database, outboxId: string): Promise<OutboxRow | null> {
    return db.prepare('SELECT * FROM outbox WHERE outbox_id = ?1').bind(outboxId).first<OutboxRow>();
  },
};
