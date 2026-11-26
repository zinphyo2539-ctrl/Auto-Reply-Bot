import type { Env, MessageBatch, OutboxQueuePayload } from '../types/bindings';
import { outboxRepository } from '../repositories/outboxRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { telegramService } from '../services/telegramService';
import { outboxService } from '../services/outboxService';
import { generateLeaseToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { ExternalServiceError, PermanentProcessingError, RateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';

export const outboxConsumer = {
  async processBatch(env: Env, batch: MessageBatch<OutboxQueuePayload>): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await this.processSingleOutbox(env, msg.body.outboxId, msg.body.correlationId, msg.body.eventId);
        msg.ack();
      } catch (err) {
        logger.log({
          level: 'ERROR',
          event: 'QUEUE_ITEM_EXCEPTION',
          correlationId: msg.body.correlationId,
          outboxId: msg.body.outboxId,
          message: err instanceof Error ? err.message : String(err),
        });
        msg.retry();
      }
    }
  },

  async processSingleOutbox(
    env: Env,
    outboxId: string,
    correlationId = generatePrefixedId('cor'),
    queueEventId?: string,
    nowMs = systemClock.now()
  ): Promise<{
    outcome: 'SENT' | 'RETRYABLE_FAILURE' | 'DELIVERY_UNCERTAIN' | 'PERMANENT_FAILURE' | 'SKIPPED';
  }> {
    const existing = await outboxRepository.getById(env.DB, outboxId);
    if (!existing) return { outcome: 'SKIPPED' };

    // Strict safety invariant: NEVER auto-replay SENT, PERMANENT_FAILURE, or DELIVERY_UNCERTAIN
    if (
      existing.status === 'SENT' ||
      existing.status === 'PERMANENT_FAILURE' ||
      existing.status === 'DELIVERY_UNCERTAIN'
    ) {
      return { outcome: 'SKIPPED' };
    }

    const leaseOwner = queueEventId ?? generatePrefixedId('con', nowMs);
    const leaseToken = generateLeaseToken(nowMs);

    // Phase 1: PENDING | RETRYABLE_FAILURE -> CLAIMED (enforcing per-chat ordering)
    const claimed = await outboxRepository.claimForConsumer(env.DB, {
      outboxId,
      leaseOwner,
      leaseToken,
      nowMs,
    });
    if (!claimed) {
      return { outcome: 'SKIPPED' };
    }

    // Phase 2: CLAIMED -> SENDING immediately prior to network dispatch
    const markedSending = await outboxRepository.markSending(env.DB, outboxId, leaseToken, nowMs);
    if (!markedSending) {
      return { outcome: 'SKIPPED' };
    }

    const payload = JSON.parse(claimed.payload_json) as Record<string, unknown>;

    try {
      const apiRes = await telegramService.callApi(
        env.TELEGRAM_BOT_TOKEN,
        claimed.telegram_method,
        payload
      );

      await outboxRepository.markSent(env.DB, {
        outbox: claimed,
        leaseToken,
        telegramMessageId: apiRes.messageId,
        nowMs: systemClock.now(),
      });
      return { outcome: 'SENT' };
    } catch (err) {
      const errNow = systemClock.now();

      if (err instanceof RateLimitError) {
        const delayMs = Math.max(err.retryAfterSeconds, 5) * 1000;
        await outboxRepository.markRetryableFailure(env.DB, {
          outbox: claimed,
          leaseToken,
          nextAvailableAt: errNow + delayMs,
          errorMsg: err.message,
          nowMs: errNow,
        });
        return { outcome: 'RETRYABLE_FAILURE' };
      }

      if (err instanceof ExternalServiceError) {
        if (err.isUncertainDelivery && claimed.is_idempotent_method === 0) {
          await outboxRepository.markDeliveryUncertain(env.DB, {
            outbox: claimed,
            leaseToken,
            errorMsg: err.message,
            nowMs: errNow,
          });
          await auditRepository.appendImmediate(env.DB, {
            actorId: leaseOwner,
            actorRole: 'SYSTEM',
            action: 'OUTBOX_MARKED_DELIVERY_UNCERTAIN',
            resourceType: 'OUTBOX',
            resourceId: outboxId,
            result: 'FAILURE',
            reason: err.message,
            correlationId,
            nowMs: errNow,
          });
          return { outcome: 'DELIVERY_UNCERTAIN' };
        }

        if (err.retryable) {
          const backoffMs = Math.min(300000, Math.pow(2, claimed.attempt_count) * 5000);
          await outboxRepository.markRetryableFailure(env.DB, {
            outbox: claimed,
            leaseToken,
            nextAvailableAt: errNow + backoffMs,
            errorMsg: err.message,
            nowMs: errNow,
          });
          return { outcome: 'RETRYABLE_FAILURE' };
        }
      }

      // Permanent failure (e.g. 400/403 bot blocked/kicked)
      const errMsg = err instanceof Error ? err.message : String(err);
      await outboxRepository.markPermanentFailure(env.DB, {
        outbox: claimed,
        leaseToken,
        errorMsg: errMsg,
        nowMs: errNow,
      });

      await auditRepository.appendImmediate(env.DB, {
        actorId: leaseOwner,
        actorRole: 'SYSTEM',
        action: 'OUTBOX_PERMANENT_FAILURE',
        resourceType: 'OUTBOX',
        resourceId: outboxId,
        result: 'FAILURE',
        afterState: { targetChatId: claimed.target_chat_id, eventType: claimed.event_type },
        reason: errMsg,
        correlationId,
        nowMs: errNow,
      });

      // Emergency SUPER_ADMIN DM Fallback if delivery to TELEGRAM_ADMIN_GROUP_ID failed permanently
      if (
        claimed.target_chat_id === env.TELEGRAM_ADMIN_GROUP_ID &&
        (claimed.event_type === 'GROUP_ALERT' || err instanceof PermanentProcessingError)
      ) {
        const superAdmins = await adminRepository.listActiveSuperAdmins(env.DB);
        const fallbackStmts = [];
        const fallbackPayloads: OutboxQueuePayload[] = [];

        for (const sa of superAdmins) {
          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', errNow),
            baseIdempotencyKey: `emerg_sa_fallback:${outboxId}:${sa.telegram_user_id}`,
            eventType: 'EMERGENCY_SUPER_ADMIN_FALLBACK',
            aggregateType: 'SYSTEM',
            aggregateId: outboxId,
            targetChatId: sa.telegram_user_id,
            text: `🚨 <b>EMERGENCY ADMIN GROUP DELIVERY FAILURE</b>\nCould not deliver alert <code>${outboxId}</code> to group <code>${claimed.target_chat_id}</code>.\nError: <code>${errMsg}</code>`,
            parseMode: 'HTML',
            correlationId,
            nowMs: errNow,
          });
          fallbackStmts.push(...staged.statements);
          fallbackPayloads.push(...staged.queuePayloads);
        }

        if (fallbackStmts.length > 0) {
          await executeAtomicBatch(env.DB, fallbackStmts);
          await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, fallbackPayloads);
        }
      }

      return { outcome: 'PERMANENT_FAILURE' };
    }
  },
};
