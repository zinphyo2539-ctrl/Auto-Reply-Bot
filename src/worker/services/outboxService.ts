import type { D1Database, D1PreparedStatement, Env, OutboxQueuePayload, QueueProducer } from '../types/bindings';
import type { OutboxRow } from '../types/domain';
import { outboxRepository, type EnqueueOutboxSpec } from '../repositories/outboxRepository';
import { adminRepository } from '../repositories/adminRepository';
import { isValidTelegramChatId } from './telegramService';
import { chunkTelegramText } from '../lib/textChunker';
import { generatePrefixedId } from '../lib/ids';
import { logger } from '../lib/logger';

export interface StagedOutboxBatch {
  statements: D1PreparedStatement[];
  queuePayloads: OutboxQueuePayload[];
}

export const outboxService = {
  prepareChunkedTextOutbox(
    db: D1Database,
    params: {
      baseOutboxId: string;
      baseIdempotencyKey: string;
      eventType: string;
      aggregateType: EnqueueOutboxSpec['aggregateType'];
      aggregateId: string;
      targetChatId: string;
      orderingKey?: string;
      text: string;
      parseMode?: 'HTML';
      replyMarkup?: Record<string, unknown>;
      relatedMessageId?: string | null;
      relatedTicketId?: string | null;
      correlationId: string;
      nowMs: number;
      gateCondition?: EnqueueOutboxSpec['gateCondition'];
      customerModeGate?: EnqueueOutboxSpec['customerModeGate'];
    }
  ): StagedOutboxBatch {
    const safeTargetChatId = isValidTelegramChatId(params.targetChatId)
      ? params.targetChatId.trim()
      : 'UNCONFIGURED_ADMIN_GROUP_CHAT';
    const effectiveOrderingKey = params.orderingKey?.trim() || safeTargetChatId;
    const chunks = chunkTelegramText(params.text, 3800);
    const statements: D1PreparedStatement[] = [];
    const queuePayloads: OutboxQueuePayload[] = [];

    chunks.forEach((chunkText, index) => {
      const seq = index + 1;
      const isLastChunk = index === chunks.length - 1;
      const outboxId = chunks.length === 1 ? params.baseOutboxId : `${params.baseOutboxId}_c${seq}`;
      const idempotencyKey =
        chunks.length === 1 ? params.baseIdempotencyKey : `${params.baseIdempotencyKey}:c${seq}`;

      const payload: Record<string, unknown> = {
        chat_id: safeTargetChatId,
        text: chunkText,
        link_preview_options: { is_disabled: true },
      };
      if (params.parseMode) {
        payload.parse_mode = params.parseMode;
      }
      if (isLastChunk && params.replyMarkup) {
        payload.reply_markup = params.replyMarkup;
      }

      const availableAt = params.nowMs + index * 250;
      statements.push(
        outboxRepository.prepareEnqueue(db, {
          outboxId,
          idempotencyKey,
          eventType: params.eventType,
          aggregateType: params.aggregateType,
          aggregateId: params.aggregateId,
          targetChatId: safeTargetChatId,
          orderingKey: effectiveOrderingKey,
          sequenceNo: seq,
          telegramMethod: 'sendMessage',
          payload,
          relatedMessageId: isLastChunk ? params.relatedMessageId : null,
          relatedTicketId: isLastChunk ? params.relatedTicketId : null,
          availableAt,
          nowMs: params.nowMs,
          gateCondition: params.gateCondition,
          customerModeGate: params.customerModeGate,
        })
      );

      queuePayloads.push({
        eventId: `qev_${outboxId}_att_1`,
        outboxId,
        orderingKey: effectiveOrderingKey,
        sequenceNo: seq,
        correlationId: params.correlationId,
      });
    });

    return { statements, queuePayloads };
  },

  filterCreatedQueuePayloads(
    batchResults: Array<{ results?: Array<Record<string, unknown>> }>,
    startIndex: number,
    queuePayloads: OutboxQueuePayload[]
  ): OutboxQueuePayload[] {
    const createdIds = new Set<string>();
    for (let i = 0; i < queuePayloads.length; i++) {
      const rows = batchResults[startIndex + i]?.results ?? [];
      for (const row of rows) {
        if (typeof row.outbox_id === 'string') {
          createdIds.add(row.outbox_id);
        }
      }
    }
    return queuePayloads.filter((p) => createdIds.has(p.outboxId));
  },

  async dispatchQueueSignalsBestEffort(
    queue: QueueProducer<OutboxQueuePayload> | undefined,
    payloads: OutboxQueuePayload[]
  ): Promise<void> {
    if (!queue || payloads.length === 0) {
      return;
    }
    try {
      if (payloads.length === 1) {
        await queue.send(payloads[0]);
      } else {
        await queue.sendBatch(payloads.map((body) => ({ body })));
      }
    } catch (err) {
      // Never throw after D1 commit; 1-minute leaseRecoveryCron will discover and re-dispatch due PENDING rows
      logger.log({
        level: 'WARN',
        event: 'QUEUE_DISPATCH_SIGNAL_DEFERRED_TO_CRON',
        correlationId: payloads[0].correlationId,
        message: err instanceof Error ? err.message : String(err),
        metadata: { count: payloads.length },
      });
    }
  },

  /**
   * Operational Recovery Path for Held Admin Notifications:
   * Invoked when a SUPER_ADMIN runs /start in private chat or by the 1-minute lease recovery cron.
   * - If TELEGRAM_ADMIN_GROUP_ID is now configured with a valid chat ID, heals any pending/held
   *   'UNCONFIGURED_ADMIN_GROUP_CHAT' outbox rows to target the real group chat ID.
   * - If at least one active started SUPER_ADMIN is now available, wakes any held admin outbox rows
   *   so outboxConsumer can immediately deliver them via EMERGENCY_SUPER_ADMIN_FALLBACK.
   */
  async recoverHeldAdminNotifications(
    env: Env,
    nowMs: number,
    correlationId = generatePrefixedId('rec', nowMs)
  ): Promise<{ healedGroupTargetCount: number; releasedForDispatchCount: number }> {
    const hasValidGroup = isValidTelegramChatId(env.TELEGRAM_ADMIN_GROUP_ID);
    const configuredGroupId = hasValidGroup ? env.TELEGRAM_ADMIN_GROUP_ID.trim() : null;
    const activeStartedSuperAdmins = await adminRepository.listActiveSuperAdmins(env.DB);

    if (!configuredGroupId && activeStartedSuperAdmins.length === 0) {
      return { healedGroupTargetCount: 0, releasedForDispatchCount: 0 };
    }

    const heldCandidates = await env.DB
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('PENDING', 'RETRYABLE_FAILURE')
           AND (
             target_chat_id = 'UNCONFIGURED_ADMIN_GROUP_CHAT'
             OR last_error LIKE 'ADMIN_NOTIFICATION_CHANNEL_UNAVAILABLE%'
             OR last_error LIKE 'ALL_SUPER_ADMIN_FALLBACK_DMS_FAILED%'
           )
         ORDER BY created_at ASC
         LIMIT 30`
      )
      .all<OutboxRow>();

    let healedGroupTargetCount = 0;
    const payloads: OutboxQueuePayload[] = [];

    for (const row of heldCandidates.results) {
      if (configuredGroupId && row.target_chat_id === 'UNCONFIGURED_ADMIN_GROUP_CHAT') {
        const healed = await outboxRepository.healUnconfiguredTargetChatId(env.DB, {
          outboxId: row.outbox_id,
          newTargetChatId: configuredGroupId,
          nowMs,
        });
        if (healed) {
          healedGroupTargetCount++;
          payloads.push({
            eventId: generatePrefixedId('qev', nowMs),
            outboxId: healed.outbox_id,
            orderingKey: healed.ordering_key,
            sequenceNo: healed.sequence_no,
            correlationId,
          });
          continue;
        }
      }

      if (activeStartedSuperAdmins.length > 0 || configuredGroupId) {
        const woke = await env.DB
          .prepare(
            `UPDATE outbox
             SET available_at = ?2,
                 next_dispatch_at = ?2,
                 updated_at = ?2
             WHERE outbox_id = ?1
               AND status IN ('PENDING', 'RETRYABLE_FAILURE')
             RETURNING *`
          )
          .bind(row.outbox_id, nowMs)
          .first<OutboxRow>();

        if (woke) {
          payloads.push({
            eventId: generatePrefixedId('qev', nowMs),
            outboxId: woke.outbox_id,
            orderingKey: woke.ordering_key,
            sequenceNo: woke.sequence_no,
            correlationId,
          });
        }
      }
    }

    if (payloads.length > 0) {
      await this.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, payloads);
    }

    return {
      healedGroupTargetCount,
      releasedForDispatchCount: payloads.length,
    };
  },
};
