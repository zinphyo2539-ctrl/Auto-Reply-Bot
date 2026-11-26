import type { D1Database, D1PreparedStatement, OutboxQueuePayload, QueueProducer } from '../types/bindings';
import { outboxRepository, type EnqueueOutboxSpec } from '../repositories/outboxRepository';
import { chunkTelegramText } from '../lib/textChunker';
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
      text: string;
      parseMode?: 'HTML';
      replyMarkup?: Record<string, unknown>;
      relatedMessageId?: string | null;
      relatedTicketId?: string | null;
      correlationId: string;
      nowMs: number;
      gateCondition?: EnqueueOutboxSpec['gateCondition'];
    }
  ): StagedOutboxBatch {
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
        chat_id: params.targetChatId,
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
          targetChatId: params.targetChatId,
          orderingKey: params.targetChatId,
          sequenceNo: seq,
          telegramMethod: 'sendMessage',
          payload,
          relatedMessageId: isLastChunk ? params.relatedMessageId : null,
          relatedTicketId: isLastChunk ? params.relatedTicketId : null,
          availableAt,
          nowMs: params.nowMs,
          gateCondition: params.gateCondition,
        })
      );

      queuePayloads.push({
        eventId: `qev_${outboxId}_att_1`,
        outboxId,
        orderingKey: params.targetChatId,
        sequenceNo: seq,
        correlationId: params.correlationId,
      });
    });

    return { statements, queuePayloads };
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
};
