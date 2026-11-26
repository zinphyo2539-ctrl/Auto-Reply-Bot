import type { Env, OutboxQueuePayload, ScheduledController } from '../types/bindings';
import { outboxRepository } from '../repositories/outboxRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { configRepository } from '../repositories/configRepository';
import { auditRepository } from '../repositories/auditRepository';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { outboxService } from '../services/outboxService';
import { generateMutationToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';

export const scheduledDispatcher = {
  async dispatch(env: Env, controller: ScheduledController): Promise<void> {
    switch (controller.cron) {
      case '* * * * *':
        await this.runLeaseRecoveryCron(env);
        break;
      case '*/5 * * * *':
        await this.runReminderAndEscalationCron(env);
        break;
      case '0 20 * * *':
        await this.runRetentionCron(env);
        break;
      default:
        await this.runLeaseRecoveryCron(env);
        break;
    }
  },

  /**
   * Cron 1 (* * * * *):
   * - Expired CLAIMED (pre-network crash) -> reset to RETRYABLE_FAILURE
   * - Expired SENDING (in-flight network crash) -> DELIVERY_UNCERTAIN (never blind auto-replay for non-idempotent sendMessage)
   * - Due PENDING / RETRYABLE_FAILURE -> re-dispatch queue signals
   */
  async runLeaseRecoveryCron(env: Env, nowMs = systemClock.now()): Promise<{
    expiredClaimedRecovered: number;
    expiredSendingMarkedUncertain: number;
    requeuedCount: number;
  }> {
    const correlationId = generatePrefixedId('crn', nowMs);
    const expiredLeases = await outboxRepository.findExpiredActiveLeases(env.DB, nowMs, 30);

    let expiredClaimedRecovered = 0;
    let expiredSendingMarkedUncertain = 0;

    for (const row of expiredLeases) {
      if (row.status === 'CLAIMED') {
        const ok = await outboxRepository.recoverExpiredClaimedRow(env.DB, row.outbox_id, nowMs);
        if (ok) expiredClaimedRecovered++;
      } else if (row.status === 'SENDING') {
        if (row.is_idempotent_method === 1) {
          // Idempotent editMessageText can safely retry
          await env.DB
            .prepare(
              `UPDATE outbox
               SET status = 'RETRYABLE_FAILURE', available_at = ?2, next_dispatch_at = ?2,
                   lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?2
               WHERE outbox_id = ?1 AND status = 'SENDING'`
            )
            .bind(row.outbox_id, nowMs)
            .run();
          expiredClaimedRecovered++;
        } else {
          await outboxRepository.markDeliveryUncertain(env.DB, {
            outbox: row,
            errorMsg: 'SENDING lease expired without Telegram response; marked DELIVERY_UNCERTAIN',
            nowMs,
          });
          await auditRepository.appendImmediate(env.DB, {
            actorId: 'LEASE_RECOVERY_CRON',
            actorRole: 'SYSTEM',
            action: 'EXPIRED_SENDING_LEASE_MARKED_DELIVERY_UNCERTAIN',
            resourceType: 'OUTBOX',
            resourceId: row.outbox_id,
            result: 'FAILURE',
            correlationId,
            nowMs,
          });
          expiredSendingMarkedUncertain++;
        }
      }
    }

    const dueRows = await outboxRepository.claimDueForCronDispatch(env.DB, nowMs, 30);
    if (dueRows.length > 0) {
      const payloads: OutboxQueuePayload[] = dueRows.map((r) => ({
        eventId: generatePrefixedId('qev', nowMs),
        outboxId: r.outbox_id,
        orderingKey: r.ordering_key,
        sequenceNo: r.sequence_no,
        correlationId,
      }));
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, payloads);
    }

    return {
      expiredClaimedRecovered,
      expiredSendingMarkedUncertain,
      requeuedCount: dueRows.length,
    };
  },

  /**
   * Cron 2 (every 5 minutes):
   * - 30m idle assigned ticket reminder
   * - 60m idle assigned ticket escalation
   */
  async runReminderAndEscalationCron(env: Env, nowMs = systemClock.now()): Promise<{
    remindersQueued: number;
    escalationsQueued: number;
  }> {
    const correlationId = generatePrefixedId('sla', nowMs);
    const config = await configRepository.getActiveConfig(env.DB);
    const reminderCutoff = nowMs - config.reminder_minutes * 60 * 1000;
    const escalationCutoff = nowMs - config.escalation_minutes * 60 * 1000;

    let remindersQueued = 0;
    let escalationsQueued = 0;
    const queuePayloads: OutboxQueuePayload[] = [];

    const reminderCandidates = await ticketRepository.findIdleReminderCandidates(env.DB, reminderCutoff, 20);
    for (const ticket of reminderCandidates) {
      const mutationToken = generateMutationToken(nowMs);
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `sla_rem:${ticket.ticket_id}:v${ticket.version + 1}`,
        eventType: 'SLA_REMINDER',
        aggregateType: 'TICKET',
        aggregateId: ticket.ticket_id,
        targetChatId: ticket.assigned_admin_id ?? env.TELEGRAM_ADMIN_GROUP_ID,
        text: `⏰ <b>${config.reminder_minutes}-Minute SLA Reminder</b>\nAssigned Ticket <code>${ticket.ticket_id}</code> (Customer <code>${ticket.customer_id}</code>) has no recent admin activity.`,
        parseMode: 'HTML',
        relatedTicketId: ticket.ticket_id,
        correlationId,
        nowMs,
        gateCondition: {
          table: 'support_tickets',
          pkColumn: 'ticket_id',
          pkValue: ticket.ticket_id,
          mutationToken,
        },
      });

      const auditStmt = await auditRepository.buildInsertStatement(
        env.DB,
        {
          actorId: 'SLA_CRON',
          actorRole: 'SYSTEM',
          action: 'TICKET_SLA_REMINDER_QUEUED',
          resourceType: 'TICKET',
          resourceId: ticket.ticket_id,
          result: 'SUCCESS',
          correlationId,
          nowMs,
        },
        {
          table: 'support_tickets',
          pkColumn: 'ticket_id',
          pkValue: ticket.ticket_id,
          mutationToken,
        }
      );

      const results = await executeAtomicBatch(env.DB, [
        env.DB
          .prepare(
            `UPDATE support_tickets
             SET reminder_sent = 1, version = version + 1, last_mutation_token = ?2, updated_at = ?3
             WHERE ticket_id = ?1 AND status = 'ASSIGNED' AND reminder_sent = 0 AND version = ?4
             RETURNING ticket_id`
          )
          .bind(ticket.ticket_id, mutationToken, nowMs, ticket.version),
        auditStmt,
        ...staged.statements,
      ]);

      if ((results[0]?.results?.length ?? 0) > 0) {
        remindersQueued++;
        queuePayloads.push(...staged.queuePayloads);
      }
    }

    const escalationCandidates = await ticketRepository.findIdleEscalationCandidates(env.DB, escalationCutoff, 20);
    for (const ticket of escalationCandidates) {
      const mutationToken = generateMutationToken(nowMs);
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `sla_esc:${ticket.ticket_id}:v${ticket.version + 1}`,
        eventType: 'SLA_ESCALATION',
        aggregateType: 'TICKET',
        aggregateId: ticket.ticket_id,
        targetChatId: env.TELEGRAM_ADMIN_GROUP_ID,
        text: `🚨 <b>${config.escalation_minutes}-Minute SLA ESCALATION</b>\nTicket <code>${ticket.ticket_id}</code> (Customer <code>${ticket.customer_id}</code>, Assigned: <code>${ticket.assigned_admin_id ?? 'NONE'}</code>) exceeded idle SLA threshold!`,
        parseMode: 'HTML',
        relatedTicketId: ticket.ticket_id,
        correlationId,
        nowMs,
        gateCondition: {
          table: 'support_tickets',
          pkColumn: 'ticket_id',
          pkValue: ticket.ticket_id,
          mutationToken,
        },
      });

      const auditStmt = await auditRepository.buildInsertStatement(
        env.DB,
        {
          actorId: 'SLA_CRON',
          actorRole: 'SYSTEM',
          action: 'TICKET_SLA_ESCALATED',
          resourceType: 'TICKET',
          resourceId: ticket.ticket_id,
          result: 'SUCCESS',
          correlationId,
          nowMs,
        },
        {
          table: 'support_tickets',
          pkColumn: 'ticket_id',
          pkValue: ticket.ticket_id,
          mutationToken,
        }
      );

      const results = await executeAtomicBatch(env.DB, [
        env.DB
          .prepare(
            `UPDATE support_tickets
             SET escalated = 1, version = version + 1, last_mutation_token = ?2, updated_at = ?3
             WHERE ticket_id = ?1 AND status = 'ASSIGNED' AND escalated = 0 AND version = ?4
             RETURNING ticket_id`
          )
          .bind(ticket.ticket_id, mutationToken, nowMs, ticket.version),
        auditStmt,
        ...staged.statements,
      ]);

      if ((results[0]?.results?.length ?? 0) > 0) {
        escalationsQueued++;
        queuePayloads.push(...staged.queuePayloads);
      }
    }

    if (queuePayloads.length > 0) {
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, queuePayloads);
    }

    return { remindersQueued, escalationsQueued };
  },

  /**
   * Cron 3 (0 20 * * * = 02:30 MMT Daily):
   * - Redacts withdrawal destination ciphertext 30 days after terminal status
   * - Purges expired sessions and expired processed_updates
   * - Records RETENTION_CLEANUP audit log
   */
  async runRetentionCron(env: Env, nowMs = systemClock.now()): Promise<{
    withdrawalCiphertextsRedacted: number;
    expiredSessionsDeleted: number;
    expiredUpdatesDeleted: number;
  }> {
    const correlationId = generatePrefixedId('ret', nowMs);
    const piiDays = Number(env.RETENTION_WITHDRAWAL_PII_DAYS ?? '30');
    const piiCutoffMs = nowMs - piiDays * 86400000;

    const redactRes = await env.DB
      .prepare(
        `UPDATE withdrawal_requests
         SET destination_ciphertext = 'REDACTED',
             destination_iv = 'REDACTED',
             updated_at = ?1
         WHERE rowid IN (
           SELECT rowid FROM withdrawal_requests
           WHERE status IN ('PAID_RECORDED', 'REJECTED', 'CANCELLED_BY_CUSTOMER')
             AND destination_ciphertext != 'REDACTED'
             AND updated_at <= ?2
           LIMIT 500
         )`
      )
      .bind(nowMs, piiCutoffMs)
      .run();

    const sessRes = await env.DB
      .prepare(
        `DELETE FROM customer_sessions
         WHERE rowid IN (SELECT rowid FROM customer_sessions WHERE expires_at <= ?1 LIMIT 500)`
      )
      .bind(nowMs)
      .run();

    const updRes = await env.DB
      .prepare(
        `DELETE FROM processed_updates
         WHERE rowid IN (SELECT rowid FROM processed_updates WHERE status = 'COMPLETED' AND expires_at <= ?1 LIMIT 500)`
      )
      .bind(nowMs)
      .run();

    const withdrawalCiphertextsRedacted = redactRes.meta.changes ?? 0;
    const expiredSessionsDeleted = sessRes.meta.changes ?? 0;
    const expiredUpdatesDeleted = updRes.meta.changes ?? 0;

    await auditRepository.appendImmediate(env.DB, {
      actorId: 'RETENTION_CRON',
      actorRole: 'SYSTEM',
      action: 'RETENTION_CLEANUP',
      resourceType: 'SYSTEM',
      resourceId: 'D1_RETENTION',
      result: 'SUCCESS',
      afterState: {
        withdrawalCiphertextsRedacted,
        expiredSessionsDeleted,
        expiredUpdatesDeleted,
      },
      correlationId,
      nowMs,
    });

    return {
      withdrawalCiphertextsRedacted,
      expiredSessionsDeleted,
      expiredUpdatesDeleted,
    };
  },
};
