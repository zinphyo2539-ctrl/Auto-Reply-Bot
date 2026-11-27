import type { Env, MessageBatch, OutboxQueuePayload } from '../types/bindings';
import { outboxRepository } from '../repositories/outboxRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { isValidTelegramChatId, telegramService } from '../services/telegramService';
import { outboxService } from '../services/outboxService';
import { generateLeaseToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { escapeHtml } from '../lib/textChunker';
import { ExternalServiceError, PermanentProcessingError, RateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';

const QUEUE_EVENT_TTL_MS = 7 * 86400000;
const QUEUE_EVENT_STALE_LEASE_MS = 45_000;

interface QueueEventRow {
  event_id: string;
  outbox_id: string;
  consumer_lease_token: string;
  outcome: 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED';
  processed_at: number;
  expires_at: number;
}

/**
 * F-06C: Durable pre-claim idempotency guard backed by processed_queue_events.
 * Prevents duplicate queue event delivery from racing or re-processing completed/active events.
 */
async function acquireQueueEventGuard(
  env: Env,
  queueEventId: string | undefined,
  outboxId: string,
  consumerLeaseToken: string,
  nowMs: number
): Promise<boolean> {
  if (!queueEventId) return true;

  const inserted = await env.DB
    .prepare(
      `INSERT INTO processed_queue_events (
         event_id, outbox_id, consumer_lease_token, outcome, processed_at, expires_at
       ) VALUES (?1, ?2, ?3, 'IN_PROGRESS', ?4, ?5)
       ON CONFLICT(event_id) DO NOTHING
       RETURNING *`
    )
    .bind(queueEventId, outboxId, consumerLeaseToken, nowMs, nowMs + QUEUE_EVENT_TTL_MS)
    .first<QueueEventRow>();

  if (inserted) {
    return true;
  }

  const existing = await env.DB
    .prepare('SELECT * FROM processed_queue_events WHERE event_id = ?1')
    .bind(queueEventId)
    .first<QueueEventRow>();

  if (!existing) {
    return false;
  }

  if (existing.outcome === 'COMPLETED' || existing.outcome === 'ABORTED') {
    return false;
  }

  // Only reclaim IN_PROGRESS queue event if its lease is stale
  if (existing.processed_at > nowMs - QUEUE_EVENT_STALE_LEASE_MS) {
    return false;
  }

  const reclaimed = await env.DB
    .prepare(
      `UPDATE processed_queue_events
       SET consumer_lease_token = ?2,
           processed_at = ?3,
           expires_at = ?4
       WHERE event_id = ?1
         AND outcome = 'IN_PROGRESS'
         AND processed_at <= ?5
       RETURNING *`
    )
    .bind(
      queueEventId,
      consumerLeaseToken,
      nowMs,
      nowMs + QUEUE_EVENT_TTL_MS,
      nowMs - QUEUE_EVENT_STALE_LEASE_MS
    )
    .first<QueueEventRow>();

  return reclaimed !== null;
}

async function finalizeQueueEventGuard(
  env: Env,
  queueEventId: string | undefined,
  consumerLeaseToken: string,
  outcome: 'COMPLETED' | 'ABORTED',
  nowMs: number
): Promise<void> {
  if (!queueEventId) return;
  try {
    await env.DB
      .prepare(
        `UPDATE processed_queue_events
         SET outcome = ?3,
             processed_at = ?4,
             expires_at = ?5
         WHERE event_id = ?1
           AND consumer_lease_token = ?2`
      )
      .bind(queueEventId, consumerLeaseToken, outcome, nowMs, nowMs + QUEUE_EVENT_TTL_MS)
      .run();
  } catch {
    // Non-fatal; outbox lease remains authoritative
  }
}

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

  /**
   * F-06D: Explicit Dead-Letter Queue consumer.
   * Never auto-replays messages (avoids duplicate non-idempotent sends) and never logs payloads/PII.
   * Persists an immutable audit record, sends a bounded non-sensitive alert to started SUPER_ADMINs, and acks.
   */
  async processDlqBatch(
    env: Env,
    batch: MessageBatch<OutboxQueuePayload>,
    nowMs = systemClock.now()
  ): Promise<{ processedCount: number }> {
    let processedCount = 0;

    for (const msg of batch.messages) {
      const outboxId = msg.body?.outboxId ?? `unknown:${msg.id}`;
      const eventId = msg.body?.eventId ?? msg.id;
      const correlationId = msg.body?.correlationId ?? generatePrefixedId('dlq', nowMs);

      logger.log({
        level: 'ERROR',
        event: 'OUTBOX_DLQ_MESSAGE_RECEIVED',
        correlationId,
        outboxId,
        metadata: {
          queue: batch.queue,
          messageId: msg.id,
          eventId,
          attempts: msg.attempts,
        },
      });

      const existingOutbox = msg.body?.outboxId
        ? await outboxRepository.getById(env.DB, msg.body.outboxId)
        : null;

      await auditRepository.appendImmediate(env.DB, {
        actorId: 'OUTBOX_DLQ_CONSUMER',
        actorRole: 'SYSTEM',
        action: 'OUTBOX_DLQ_EVENT_RECORDED',
        resourceType: 'OUTBOX',
        resourceId: outboxId,
        result: 'FAILURE',
        afterState: {
          queue: batch.queue,
          messageId: msg.id,
          eventId,
          attempts: msg.attempts,
          outboxStatus: existingOutbox?.status ?? 'UNKNOWN',
          outboxEventType: existingOutbox?.event_type ?? 'UNKNOWN',
        },
        reason: 'Queue message routed to DLQ; manual inspection required (auto-replay forbidden)',
        correlationId,
        nowMs,
      });

      // Avoid alert recursion if the DLQ message itself was already a DLQ_ALERT
      if (existingOutbox?.event_type !== 'DLQ_ALERT') {
        const superAdmins = await adminRepository.listActiveSuperAdmins(env.DB);
        const alertStmts = [];
        const alertPayloads: OutboxQueuePayload[] = [];

        for (const sa of superAdmins) {
          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', nowMs),
            baseIdempotencyKey: `dlq_alert:${outboxId}:${sa.telegram_user_id}`,
            eventType: 'DLQ_ALERT',
            aggregateType: 'SYSTEM',
            aggregateId: outboxId,
            targetChatId: sa.telegram_user_id,
            text: `🚨 <b>Outbox Dead-Letter Queue Alert</b>\nOutbox ID: <code>${escapeHtml(outboxId)}</code>\nEvent ID: <code>${escapeHtml(eventId)}</code>\nStatus: <b>${escapeHtml(existingOutbox?.status ?? 'UNKNOWN')}</b>\nManual operator inspection required. Auto-replay is disabled for safety.`,
            parseMode: 'HTML',
            correlationId,
            nowMs,
          });
          alertStmts.push(...staged.statements);
          alertPayloads.push(...staged.queuePayloads);
        }

        if (alertStmts.length > 0) {
          await executeAtomicBatch(env.DB, alertStmts);
          await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, alertPayloads);
        }
      }

      msg.ack();
      processedCount++;
    }

    return { processedCount };
  },

  async processSingleOutbox(
    env: Env,
    outboxId: string,
    correlationId = generatePrefixedId('cor'),
    queueEventId?: string,
    nowMs?: number,
    clock?: () => number
  ): Promise<{
    outcome: 'SENT' | 'RETRYABLE_FAILURE' | 'DELIVERY_UNCERTAIN' | 'PERMANENT_FAILURE' | 'SKIPPED';
  }> {
    const getNow = clock ?? (nowMs !== undefined ? () => nowMs : () => systemClock.now());
    const startNow = getNow();

    let existing = await outboxRepository.getById(env.DB, outboxId);
    if (!existing) return { outcome: 'SKIPPED' };

    // Strict safety invariant: NEVER auto-replay SENT, PERMANENT_FAILURE, or DELIVERY_UNCERTAIN
    if (
      existing.status === 'SENT' ||
      existing.status === 'PERMANENT_FAILURE' ||
      existing.status === 'DELIVERY_UNCERTAIN'
    ) {
      return { outcome: 'SKIPPED' };
    }

    // Dynamic healing if TELEGRAM_ADMIN_GROUP_ID was configured after an UNCONFIGURED_ADMIN_GROUP_CHAT row was created
    if (
      (existing.status === 'PENDING' || existing.status === 'RETRYABLE_FAILURE') &&
      existing.target_chat_id === 'UNCONFIGURED_ADMIN_GROUP_CHAT' &&
      isValidTelegramChatId(env.TELEGRAM_ADMIN_GROUP_ID)
    ) {
      const healed = await outboxRepository.healUnconfiguredTargetChatId(env.DB, {
        outboxId,
        newTargetChatId: env.TELEGRAM_ADMIN_GROUP_ID.trim(),
        nowMs: startNow,
      });
      if (healed) {
        existing = healed;
      }
    }

    const leaseOwner = queueEventId ?? generatePrefixedId('con', startNow);
    const leaseToken = generateLeaseToken(startNow);

    // F-06C: Durable pre-claim deduplication via processed_queue_events
    const acquiredEvent = await acquireQueueEventGuard(env, queueEventId, outboxId, leaseToken, startNow);
    if (!acquiredEvent) {
      return { outcome: 'SKIPPED' };
    }

    // F-06: Fence expired in-flight leases on consumer reclaim BEFORE attempting any claim or Telegram send.
    // Non-idempotent SENDING rows (sendMessage / sendPhoto) MUST transition to DELIVERY_UNCERTAIN so a
    // reclaiming consumer can never trigger a duplicate Telegram message and the stale worker is fenced out.
    if (
      existing.status === 'SENDING' &&
      existing.lease_expires_at !== null &&
      existing.lease_expires_at <= startNow
    ) {
      if (existing.is_idempotent_method === 0) {
        const fenced = await outboxRepository.markDeliveryUncertain(env.DB, {
          outbox: existing,
          errorMsg:
            'SENDING lease expired on consumer reclaim; fenced to DELIVERY_UNCERTAIN without duplicate Telegram send',
          nowMs: startNow,
        });
        if (fenced) {
          await auditRepository.appendImmediate(env.DB, {
            actorId: leaseOwner,
            actorRole: 'SYSTEM',
            action: 'EXPIRED_SENDING_LEASE_MARKED_DELIVERY_UNCERTAIN',
            resourceType: 'OUTBOX',
            resourceId: outboxId,
            result: 'FAILURE',
            beforeState: {
              status: existing.status,
              leaseOwner: existing.lease_owner,
              leaseExpiresAt: existing.lease_expires_at,
              attemptCount: existing.attempt_count,
            },
            afterState: {
              status: 'DELIVERY_UNCERTAIN',
              telegramMethod: existing.telegram_method,
              fencedByConsumer: leaseOwner,
            },
            reason: 'Expired non-idempotent SENDING lease fenced on queue reclaim',
            correlationId,
            nowMs: startNow,
          });
        }
        await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', startNow);
        return { outcome: fenced ? 'DELIVERY_UNCERTAIN' : 'SKIPPED' };
      }

      // Idempotent editMessageText can safely be recovered to RETRYABLE_FAILURE and re-claimed
      await outboxRepository.recoverExpiredSendingIdempotentRow(env.DB, outboxId, startNow);
    } else if (
      existing.status === 'CLAIMED' &&
      existing.lease_expires_at !== null &&
      existing.lease_expires_at <= startNow
    ) {
      // Pre-network CLAIMED crash can safely be recovered before claimForConsumer
      await outboxRepository.recoverExpiredClaimedRow(env.DB, outboxId, startNow);
    }

    // Phase 1: PENDING | RETRYABLE_FAILURE -> CLAIMED (enforcing per-chat ordering)
    const claimed = await outboxRepository.claimForConsumer(env.DB, {
      outboxId,
      leaseOwner,
      leaseToken,
      nowMs: startNow,
    });
    if (!claimed) {
      await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', startNow);
      return { outcome: 'SKIPPED' };
    }

    // Phase 2: CLAIMED -> SENDING immediately prior to network dispatch
    const sendingNow = getNow();
    const markedSending = await outboxRepository.markSending(env.DB, outboxId, leaseToken, sendingNow);
    if (!markedSending) {
      await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', sendingNow);
      return { outcome: 'SKIPPED' };
    }

    const payload = JSON.parse(claimed.payload_json) as Record<string, unknown>;

    try {
      const apiRes = await telegramService.callApi(
        env.TELEGRAM_BOT_TOKEN,
        claimed.telegram_method,
        payload
      );

      const sentNow = getNow();
      const markedSent = await outboxRepository.markSent(env.DB, {
        outbox: claimed,
        leaseToken,
        telegramMessageId: apiRes.messageId,
        nowMs: sentNow,
      });

      if (!markedSent) {
        const currentRow = await outboxRepository.getById(env.DB, outboxId);
        logger.log({
          level: 'WARN',
          event: 'OUTBOX_LEASE_LOST_AFTER_TELEGRAM_SEND',
          correlationId,
          outboxId,
          metadata: {
            telegramMessageId: apiRes.messageId,
            currentOutboxStatus: currentRow?.status ?? 'UNKNOWN',
          },
        });
        await auditRepository.appendImmediate(env.DB, {
          actorId: leaseOwner,
          actorRole: 'SYSTEM',
          action: 'OUTBOX_LATE_TELEGRAM_SUCCESS_AFTER_LEASE_LOSS',
          resourceType: 'OUTBOX',
          resourceId: outboxId,
          result: 'CONFLICT',
          afterState: {
            telegramMessageId: apiRes.messageId,
            telegramMethod: claimed.telegram_method,
            staleLeaseOwner: leaseOwner,
            currentOutboxStatus: currentRow?.status ?? 'UNKNOWN',
          },
          reason:
            'Telegram API returned 200 OK after worker lease expired or was fenced; outbox and message state left untouched for reconciliation',
          correlationId,
          nowMs: sentNow,
        });
        await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', sentNow);
        return { outcome: 'SKIPPED' };
      }

      await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'COMPLETED', sentNow);
      return { outcome: 'SENT' };
    } catch (err) {
      const errNow = getNow();
      let isExhaustedRetry = false;

      if (err instanceof RateLimitError) {
        if (claimed.attempt_count < claimed.max_attempts) {
          const delayMs = Math.max(err.retryAfterSeconds, 5) * 1000;
          const markedRetry = await outboxRepository.markRetryableFailure(env.DB, {
            outbox: claimed,
            leaseToken,
            nextAvailableAt: errNow + delayMs,
            errorMsg: err.message,
            nowMs: errNow,
          });
          await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
          return { outcome: markedRetry ? 'RETRYABLE_FAILURE' : 'SKIPPED' };
        }
        isExhaustedRetry = true;
      }

      if (err instanceof ExternalServiceError) {
        if (err.isUncertainDelivery && claimed.is_idempotent_method === 0) {
          const markedUncertain = await outboxRepository.markDeliveryUncertain(env.DB, {
            outbox: claimed,
            leaseToken,
            errorMsg: err.message,
            nowMs: errNow,
          });
          if (markedUncertain) {
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
          }
          await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
          return { outcome: markedUncertain ? 'DELIVERY_UNCERTAIN' : 'SKIPPED' };
        }

        if (err.retryable) {
          if (claimed.attempt_count < claimed.max_attempts) {
            const backoffMs = Math.min(300000, Math.pow(2, claimed.attempt_count) * 5000);
            const markedRetry = await outboxRepository.markRetryableFailure(env.DB, {
              outbox: claimed,
              leaseToken,
              nextAvailableAt: errNow + backoffMs,
              errorMsg: err.message,
              nowMs: errNow,
            });
            await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
            return { outcome: markedRetry ? 'RETRYABLE_FAILURE' : 'SKIPPED' };
          }
          isExhaustedRetry = true;
        }
      }

      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = isExhaustedRetry ? `MAX_ATTEMPTS_EXHAUSTED: ${rawErrMsg}` : rawErrMsg;

      const configuredGroupChatId = isValidTelegramChatId(env.TELEGRAM_ADMIN_GROUP_ID)
        ? env.TELEGRAM_ADMIN_GROUP_ID.trim()
        : null;
      const isTargetAdminGroup =
        claimed.target_chat_id === 'UNCONFIGURED_ADMIN_GROUP_CHAT' ||
        !isValidTelegramChatId(claimed.target_chat_id) ||
        (configuredGroupChatId !== null && claimed.target_chat_id === configuredGroupChatId);

      // Section 6 Operational Safety Invariant:
      // If an admin group notification fails permanently (or exhausts retries), check for active started SUPER_ADMINs.
      // If ZERO active started SUPER_ADMINs exist, NEVER mark the notification SENT or abandon it in PERMANENT_FAILURE:
      // hold it in RETRYABLE_FAILURE so it recovers automatically once a SUPER_ADMIN runs /start or TELEGRAM_ADMIN_GROUP_ID is configured.
      if (
        isTargetAdminGroup &&
        (claimed.event_type === 'GROUP_ALERT' ||
          err instanceof PermanentProcessingError ||
          isExhaustedRetry)
      ) {
        const superAdmins = await adminRepository.listActiveSuperAdmins(env.DB);

        if (superAdmins.length === 0) {
          const holdReason = `ADMIN_NOTIFICATION_CHANNEL_UNAVAILABLE: ${errMsg}`;
          const held = await outboxRepository.holdForAdminRecovery(env.DB, {
            outbox: claimed,
            leaseToken,
            nextAvailableAt: errNow + 60000,
            errorMsg: holdReason,
            nowMs: errNow,
          });

          if (!held) {
            logger.log({
              level: 'WARN',
              event: 'OUTBOX_LEASE_LOST_BEFORE_ADMIN_HOLD',
              correlationId,
              outboxId,
            });
            await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
            return { outcome: 'SKIPPED' };
          }

          logger.log({
            level: 'ERROR',
            event: 'ADMIN_NOTIFICATION_NO_REACHABLE_ADMIN',
            correlationId,
            outboxId,
            ticketId: claimed.related_ticket_id,
            metadata: {
              targetChatId: claimed.target_chat_id,
              eventType: claimed.event_type,
              aggregateType: claimed.aggregate_type,
              aggregateId: claimed.aggregate_id,
              heldStatus: 'RETRYABLE_FAILURE',
            },
          });

          await auditRepository.appendImmediate(env.DB, {
            actorId: leaseOwner,
            actorRole: 'SYSTEM',
            action: 'ADMIN_NOTIFICATION_HELD_NO_REACHABLE_ADMIN',
            resourceType: 'OUTBOX',
            resourceId: outboxId,
            result: 'FAILURE',
            afterState: {
              targetChatId: claimed.target_chat_id,
              eventType: claimed.event_type,
              aggregateType: claimed.aggregate_type,
              aggregateId: claimed.aggregate_id,
              relatedTicketId: claimed.related_ticket_id,
              heldStatus: 'RETRYABLE_FAILURE',
            },
            reason: holdReason,
            correlationId,
            nowMs: errNow,
          });

          await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
          return { outcome: 'RETRYABLE_FAILURE' };
        }

        // At least one active started SUPER_ADMIN is available: mark primary group row PERMANENT_FAILURE
        // and atomically enqueue EMERGENCY_SUPER_ADMIN_FALLBACK DMs with full masked context.
        const markedPerm = await outboxRepository.markPermanentFailure(env.DB, {
          outbox: claimed,
          leaseToken,
          errorMsg: errMsg,
          nowMs: errNow,
        });

        if (!markedPerm) {
          logger.log({
            level: 'WARN',
            event: 'OUTBOX_LEASE_LOST_BEFORE_PERMANENT_FAILURE',
            correlationId,
            outboxId,
          });
          await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
          return { outcome: 'SKIPPED' };
        }

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

        const fallbackStmts = [];
        const fallbackPayloads: OutboxQueuePayload[] = [];
        const originalText = typeof payload.text === 'string' ? payload.text : '';
        const originalReplyMarkup =
          typeof payload.reply_markup === 'object' && payload.reply_markup !== null
            ? (payload.reply_markup as Record<string, unknown>)
            : undefined;

        for (const sa of superAdmins) {
          const fallbackBody = originalText
            ? `🚨 <b>EMERGENCY ADMIN GROUP DELIVERY FAILURE</b>\nCould not deliver alert <code>${escapeHtml(outboxId)}</code> to group <code>${escapeHtml(claimed.target_chat_id)}</code>.\nError: <code>${escapeHtml(errMsg)}</code>\n\n${originalText}`
            : `🚨 <b>EMERGENCY ADMIN GROUP DELIVERY FAILURE</b>\nCould not deliver alert <code>${escapeHtml(outboxId)}</code> to group <code>${escapeHtml(claimed.target_chat_id)}</code>.\nError: <code>${escapeHtml(errMsg)}</code>`;

          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', errNow),
            baseIdempotencyKey: `emerg_sa_fallback:${outboxId}:${sa.telegram_user_id}`,
            eventType: 'EMERGENCY_SUPER_ADMIN_FALLBACK',
            aggregateType: 'SYSTEM',
            aggregateId: outboxId,
            targetChatId: sa.telegram_user_id,
            orderingKey: `emerg_sa_fallback:${outboxId}:${sa.telegram_user_id}`,
            text: fallbackBody,
            parseMode: 'HTML',
            replyMarkup: originalReplyMarkup,
            relatedTicketId: claimed.related_ticket_id,
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

        await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
        return { outcome: 'PERMANENT_FAILURE' };
      }

      // Non-group permanent failure (e.g., customer or admin DM 400/403 bot blocked)
      const markedPerm = await outboxRepository.markPermanentFailure(env.DB, {
        outbox: claimed,
        leaseToken,
        errorMsg: errMsg,
        nowMs: errNow,
      });

      if (!markedPerm) {
        logger.log({
          level: 'WARN',
          event: 'OUTBOX_LEASE_LOST_BEFORE_PERMANENT_FAILURE',
          correlationId,
          outboxId,
        });
        await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
        return { outcome: 'SKIPPED' };
      }

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

      // If this row was an EMERGENCY_SUPER_ADMIN_FALLBACK DM and ALL sibling fallback DMs for the original
      // group alert also failed permanently, reopen the original group alert to RETRYABLE_FAILURE so the
      // notification is never silently lost when every Super Admin DM fails.
      if (claimed.event_type === 'EMERGENCY_SUPER_ADMIN_FALLBACK' && claimed.aggregate_id) {
        const remainingOrSucceededSiblings = await env.DB
          .prepare(
            `SELECT COUNT(*) AS cnt FROM outbox
             WHERE event_type = 'EMERGENCY_SUPER_ADMIN_FALLBACK'
               AND aggregate_id = ?1
               AND status IN ('SENT', 'PENDING', 'CLAIMED', 'SENDING', 'RETRYABLE_FAILURE')`
          )
          .bind(claimed.aggregate_id)
          .first<{ cnt: number }>();

        if ((remainingOrSucceededSiblings?.cnt ?? 0) === 0) {
          const holdReason = `ALL_SUPER_ADMIN_FALLBACK_DMS_FAILED: ${errMsg}`;
          const reopened = await outboxRepository.reopenFailedAdminOutboxForRecovery(env.DB, {
            outboxId: claimed.aggregate_id,
            nextAvailableAt: errNow + 60000,
            errorMsg: holdReason,
            nowMs: errNow,
          });
          if (reopened) {
            logger.log({
              level: 'ERROR',
              event: 'ADMIN_NOTIFICATION_NO_REACHABLE_ADMIN',
              correlationId,
              outboxId: claimed.aggregate_id,
              ticketId: claimed.related_ticket_id,
              metadata: {
                failedFallbackOutboxId: outboxId,
                heldStatus: 'RETRYABLE_FAILURE',
              },
            });
            await auditRepository.appendImmediate(env.DB, {
              actorId: leaseOwner,
              actorRole: 'SYSTEM',
              action: 'ADMIN_NOTIFICATION_HELD_NO_REACHABLE_ADMIN',
              resourceType: 'OUTBOX',
              resourceId: claimed.aggregate_id,
              result: 'FAILURE',
              afterState: {
                failedFallbackOutboxId: outboxId,
                heldStatus: 'RETRYABLE_FAILURE',
              },
              reason: holdReason,
              correlationId,
              nowMs: errNow,
            });
          }
        }
      }

      await finalizeQueueEventGuard(env, queueEventId, leaseToken, 'ABORTED', errNow);
      return { outcome: 'PERMANENT_FAILURE' };
    }
  },
};
