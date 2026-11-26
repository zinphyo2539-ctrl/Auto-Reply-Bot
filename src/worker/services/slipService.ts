import type { Env } from '../types/bindings';
import type { SlipReviewRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { slipRepository } from '../repositories/slipRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { customerRepository } from '../repositories/customerRepository';
import { adminRepository } from '../repositories/adminRepository';
import { messageRepository } from '../repositories/messageRepository';
import { auditRepository } from '../repositories/auditRepository';
import { outboxService } from './outboxService';
import { notificationService, STANDARD_SLIP_ACK_MY } from './notificationService';
import { generateMutationToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';

export const slipService = {
  async ingestCustomerSlipPhoto(
    env: Env,
    params: {
      customerId: string;
      customerFirstName: string;
      customerUsername: string | null;
      telegramMessageId: number;
      updateId: number;
      fileId: string;
      fileUniqueId: string;
      caption?: string | null;
      correlationId: string;
      nowMs?: number;
    }
  ): Promise<{ slip: SlipReviewRow; ticketId: string; isDuplicateWarning: boolean }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const mutationToken = generateMutationToken(nowMs);
    const slipId = generatePrefixedId('slp', nowMs);
    const messageId = generatePrefixedId('msg', nowMs);

    // Ensure customer exists and is switched to HUMAN mode
    const existingTicket = await ticketRepository.findActiveByCustomer(env.DB, params.customerId);
    const ticketId = existingTicket ? existingTicket.ticket_id : generatePrefixedId('tkt', nowMs);

    const intakeStmts = [
      customerRepository.prepareUpsertActiveCustomer(env.DB, {
        customerId: params.customerId,
        username: params.customerUsername,
        firstName: params.customerFirstName,
        forceHumanMode: true,
        incrementUnread: true,
        messagePreview: params.caption ?? '[Slip Image]',
        mutationToken,
        nowMs,
      }),
    ];

    if (!existingTicket) {
      intakeStmts.push(
        ticketRepository.prepareCreateIfNoActiveTicket(env.DB, {
          ticketId,
          customerId: params.customerId,
          ticketType: 'SLIP_DEPOSIT',
          slipCount: 1,
          latestSlipId: slipId,
          mutationToken,
          nowMs,
        })
      );
    }

    intakeStmts.push(
      slipRepository.prepareAtomicFingerprintUpsert(env.DB, {
        fileUniqueId: params.fileUniqueId,
        customerId: params.customerId,
        slipId,
        ticketId,
        nowMs,
      }),
      slipRepository.prepareInsertSlipReviewFromFingerprint(env.DB, {
        slipId,
        ticketId,
        customerId: params.customerId,
        fileId: params.fileId,
        fileUniqueId: params.fileUniqueId,
        initialStatus: existingTicket?.status === 'ASSIGNED' ? 'UNDER_REVIEW' : 'RECEIVED',
        mutationToken,
        nowMs,
      }),
      messageRepository.prepareInsertMessage(env.DB, {
        messageId,
        customerId: params.customerId,
        telegramMessageId: params.telegramMessageId,
        updateId: params.updateId,
        ticketId,
        direction: 'INBOUND',
        senderRole: 'USER',
        senderId: params.customerId,
        messageType: 'PHOTO',
        textContent: params.caption ?? null,
        mediaFileId: params.fileId,
        mediaFileUniqueId: params.fileUniqueId,
        isPotentialSlip: true,
        deliveryStatus: 'RECEIVED',
        createdAt: nowMs,
      })
    );

    const results = await executeAtomicBatch(env.DB, intakeStmts);
    const slipRow = (results[results.length - 2]?.results?.[0] as unknown as SlipReviewRow | undefined)
      ?? (await slipRepository.getSlipById(env.DB, slipId));

    if (!slipRow) {
      throw new ConflictError('Failed to persist slip review record');
    }

    const isDuplicateWarning = slipRow.is_duplicate_warning === 1;
    const activeTicket = (await ticketRepository.getById(env.DB, ticketId))!;

    const duplicateBanner = isDuplicateWarning
      ? '🚨 DUPLICATE SLIP WARNING: Same Telegram file_unique_id was previously submitted!'
      : null;

    const groupCard = notificationService.buildAdminGroupTicketCard({
      ticket: activeTicket,
      customerFirstName: params.customerFirstName,
      summaryText: `Slip ${slipId}${params.caption ? ` | Caption: ${params.caption}` : ''}`,
      duplicateBanner,
    });

    const stagedCustAck = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `slip_ack_cust:${slipId}`,
      eventType: 'SLIP_RECEIVED_ACK',
      aggregateType: 'SLIP',
      aggregateId: slipId,
      targetChatId: params.customerId,
      text: `${STANDARD_SLIP_ACK_MY}\n(Slip ID: <code>${slipId}</code>)`,
      parseMode: 'HTML',
      relatedTicketId: ticketId,
      correlationId: params.correlationId,
      nowMs,
    });

    const stagedGroupAlert = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `slip_grp_alert:${slipId}`,
      eventType: 'GROUP_ALERT',
      aggregateType: 'SLIP',
      aggregateId: slipId,
      targetChatId: env.TELEGRAM_ADMIN_GROUP_ID,
      text: groupCard.text,
      parseMode: 'HTML',
      replyMarkup: groupCard.replyMarkup,
      relatedTicketId: ticketId,
      correlationId: params.correlationId,
      nowMs,
    });

    const auditStmt = await auditRepository.buildInsertStatement(env.DB, {
      actorId: params.customerId,
      actorRole: 'CUSTOMER',
      action: isDuplicateWarning ? 'SLIP_SUBMITTED_DUPLICATE_DETECTED' : 'SLIP_SUBMITTED',
      resourceType: 'SLIP',
      resourceId: slipId,
      result: 'SUCCESS',
      afterState: {
        slipId,
        ticketId,
        isDuplicateWarning,
        duplicateContext: slipRow.duplicate_context_json,
      },
      correlationId: params.correlationId,
      sourceUpdateId: params.updateId,
      nowMs,
    });

    await executeAtomicBatch(env.DB, [
      auditStmt,
      ...stagedCustAck.statements,
      ...stagedGroupAlert.statements,
    ]);

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, [
      ...stagedCustAck.queuePayloads,
      ...stagedGroupAlert.queuePayloads,
    ]);

    return { slip: slipRow, ticketId, isDuplicateWarning };
  },

  async submitAdminSlipDecision(
    env: Env,
    params: {
      adminId: string;
      slipId: string;
      decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';
      reviewNote?: string | null;
      expectedVersion?: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<SlipReviewRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin || !adminRepository.hasPermission(admin, 'slip.review')) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'SLIP_DECISION_DENIED',
        resourceType: 'SLIP',
        resourceId: params.slipId,
        result: 'DENIED',
        reason: 'Missing slip.review permission',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Administrator lacks slip.review permission');
    }

    const trimmedNote = params.reviewNote?.trim() ?? null;
    if ((params.decision === 'REJECTED' || params.decision === 'NEEDS_INFO') && !trimmedNote) {
      throw new ValidationError(`A non-empty review note is mandatory when marking slip as ${params.decision}`);
    }

    const existing = await slipRepository.getSlipById(env.DB, params.slipId);
    if (!existing) {
      throw new NotFoundError(`Slip ${params.slipId} not found`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const customerNotice =
      params.decision === 'APPROVED'
        ? `✅ သင်၏ ငွေလွှဲပြေစာ (<code>${params.slipId}</code>) ကို Admin မှ စစ်ဆေးအတည်ပြုပြီးပါပြီ။`
        : params.decision === 'REJECTED'
        ? `❌ သင်၏ ငွေလွှဲပြေစာ (<code>${params.slipId}</code>) ကို ပယ်ချလိုက်ပါသည်။\nအကြောင်းပြချက်: ${trimmedNote}`
        : `❓ သင်၏ ငွေလွှဲပြေစာ (<code>${params.slipId}</code>) အတွက် အချက်အလက်ထပ်မံလိုအပ်ပါသည်။\nမှတ်ချက်: ${trimmedNote}`;

    const stagedNotice = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `slip_dec_cust:${params.slipId}:v${existing.version + 1}`,
      eventType: `SLIP_${params.decision}`,
      aggregateType: 'SLIP',
      aggregateId: params.slipId,
      targetChatId: existing.customer_id,
      text: customerNotice,
      parseMode: 'HTML',
      relatedTicketId: existing.ticket_id,
      correlationId: params.correlationId,
      nowMs,
      gateCondition: {
        table: 'slip_reviews',
        pkColumn: 'slip_id',
        pkValue: params.slipId,
        mutationToken,
      },
    });

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: admin.role,
        action: `SLIP_DECISION_${params.decision}`,
        resourceType: 'SLIP',
        resourceId: params.slipId,
        result: 'SUCCESS',
        beforeState: { reviewStatus: existing.review_status, version: existing.version },
        afterState: { reviewStatus: params.decision, reviewNote: trimmedNote, version: existing.version + 1 },
        reason: trimmedNote,
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'slip_reviews',
        pkColumn: 'slip_id',
        pkValue: params.slipId,
        mutationToken,
      }
    );

    const results = await executeAtomicBatch(env.DB, [
      slipRepository.prepareAtomicAdminReviewDecision(env.DB, {
        slipId: params.slipId,
        actorAdminId: params.adminId,
        decision: params.decision,
        reviewNote: trimmedNote,
        expectedVersion: params.expectedVersion,
        mutationToken,
        nowMs,
      }),
      auditStmt,
      ...stagedNotice.statements,
    ]);

    const updated = (results[0]?.results?.[0] as unknown as SlipReviewRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(`Slip ${params.slipId} was already decided or version mismatch`);
    }

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedNotice.queuePayloads);
    return updated;
  },
};
