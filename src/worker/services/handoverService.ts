import type { Env, OutboxQueuePayload } from '../types/bindings';
import type { SupportTicketRow, TicketType } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { ticketRepository } from '../repositories/ticketRepository';
import { customerRepository } from '../repositories/customerRepository';
import { adminRepository } from '../repositories/adminRepository';
import { messageRepository } from '../repositories/messageRepository';
import { auditRepository } from '../repositories/auditRepository';
import { slipRepository } from '../repositories/slipRepository';
import { outboxService } from './outboxService';
import { notificationService } from './notificationService';
import { generateMutationToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';

export const handoverService = {
  async escalateCustomerToHuman(
    env: Env,
    params: {
      customerId: string;
      customerFirstName: string;
      customerUsername: string | null;
      ticketType: TicketType;
      summaryText: string;
      reason: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ ticket: SupportTicketRow; createdNew: boolean }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const mutationToken = generateMutationToken(nowMs);

    const existing = await ticketRepository.findActiveByCustomer(env.DB, params.customerId);
    if (existing) {
      // Ensure customer is in HUMAN mode
      await executeAtomicBatch(env.DB, [
        customerRepository.prepareUpsertActiveCustomer(env.DB, {
          customerId: params.customerId,
          username: params.customerUsername,
          firstName: params.customerFirstName,
          forceHumanMode: true,
          incrementUnread: true,
          messagePreview: params.summaryText,
          mutationToken,
          nowMs,
        }),
      ]);
      return { ticket: existing, createdNew: false };
    }

    const ticketId = generatePrefixedId('tkt', nowMs);
    const stagedGroup = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `tkt_open_grp:${ticketId}`,
      eventType: 'GROUP_ALERT',
      aggregateType: 'TICKET',
      aggregateId: ticketId,
      targetChatId: env.TELEGRAM_ADMIN_GROUP_ID,
      text: notificationService.buildAdminGroupTicketCard({
        ticket: {
          ticket_id: ticketId,
          customer_id: params.customerId,
          ticket_type: params.ticketType,
          status: 'OPEN',
          assigned_admin_id: null,
          resolved_by_admin_id: null,
          group_notification_msg_id: null,
          assigned_at: null,
          last_admin_activity_at: null,
          reminder_sent: 0,
          escalated: 0,
          slip_count: 0,
          latest_slip_id: null,
          version: 1,
          last_mutation_token: mutationToken,
          resolved_at: null,
          created_at: nowMs,
          updated_at: nowMs,
        },
        customerFirstName: params.customerFirstName,
        summaryText: params.summaryText,
      }).text,
      parseMode: 'HTML',
      replyMarkup: notificationService.buildAdminGroupTicketCard({
        ticket: {
          ticket_id: ticketId,
          customer_id: params.customerId,
          ticket_type: params.ticketType,
          status: 'OPEN',
          assigned_admin_id: null,
          resolved_by_admin_id: null,
          group_notification_msg_id: null,
          assigned_at: null,
          last_admin_activity_at: null,
          reminder_sent: 0,
          escalated: 0,
          slip_count: 0,
          latest_slip_id: null,
          version: 1,
          last_mutation_token: mutationToken,
          resolved_at: null,
          created_at: nowMs,
          updated_at: nowMs,
        },
        customerFirstName: params.customerFirstName,
        summaryText: params.summaryText,
      }).replyMarkup,
      relatedTicketId: ticketId,
      correlationId: params.correlationId,
      nowMs,
      gateCondition: {
        table: 'support_tickets',
        pkColumn: 'ticket_id',
        pkValue: ticketId,
        mutationToken,
      },
    });

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.customerId,
        actorRole: 'CUSTOMER',
        action: 'TICKET_CREATED_AND_HANDOVER_TO_HUMAN',
        resourceType: 'TICKET',
        resourceId: ticketId,
        result: 'SUCCESS',
        afterState: { ticketType: params.ticketType, status: 'OPEN', chatMode: 'HUMAN' },
        reason: params.reason,
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'support_tickets',
        pkColumn: 'ticket_id',
        pkValue: ticketId,
        mutationToken,
      }
    );

    await executeAtomicBatch(env.DB, [
      customerRepository.prepareUpsertActiveCustomer(env.DB, {
        customerId: params.customerId,
        username: params.customerUsername,
        firstName: params.customerFirstName,
        forceHumanMode: true,
        incrementUnread: true,
        messagePreview: params.summaryText,
        mutationToken,
        nowMs,
      }),
      ticketRepository.prepareCreateIfNoActiveTicket(env.DB, {
        ticketId,
        customerId: params.customerId,
        ticketType: params.ticketType,
        mutationToken,
        nowMs,
      }),
      auditStmt,
      ...stagedGroup.statements,
    ]);

    const active = await ticketRepository.findActiveByCustomer(env.DB, params.customerId);
    if (!active) {
      throw new ConflictError('Failed to create or retrieve active support ticket');
    }

    if (active.ticket_id === ticketId) {
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedGroup.queuePayloads);
      return { ticket: active, createdNew: true };
    }
    return { ticket: active, createdNew: false };
  },

  async takeOverTicket(
    env: Env,
    params: {
      adminId: string;
      ticketId: string;
      expectedVersion?: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<SupportTicketRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin || !adminRepository.hasPermission(admin, 'ticket.claim')) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'TICKET_CLAIM_DENIED',
        resourceType: 'TICKET',
        resourceId: params.ticketId,
        result: 'DENIED',
        reason: 'Missing active admin status or ticket.claim permission',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only active administrators with ticket.claim permission can take over tickets');
    }

    if (admin.has_started_bot !== 1) {
      throw new AuthorizationError('Admin must start a private chat (/start) with the bot before claiming tickets');
    }

    const existing = await ticketRepository.getById(env.DB, params.ticketId);
    if (!existing) {
      throw new NotFoundError(`Ticket ${params.ticketId} not found`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: admin.role,
        action: 'TICKET_CLAIMED',
        resourceType: 'TICKET',
        resourceId: params.ticketId,
        result: 'SUCCESS',
        beforeState: { status: existing.status, assignedAdminId: existing.assigned_admin_id, version: existing.version },
        afterState: { status: 'ASSIGNED', assignedAdminId: params.adminId, version: existing.version + 1 },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'support_tickets',
        pkColumn: 'ticket_id',
        pkValue: params.ticketId,
        mutationToken,
      }
    );

    const results = await executeAtomicBatch(env.DB, [
      ticketRepository.prepareAtomicClaim(env.DB, {
        ticketId: params.ticketId,
        adminId: params.adminId,
        expectedVersion: params.expectedVersion,
        mutationToken,
        nowMs,
      }),
      slipRepository.prepareTransitionToUnderReviewOnClaim(env.DB, params.ticketId, mutationToken, nowMs),
      adminRepository.prepareUpsertSession(env.DB, {
        adminId: params.adminId,
        sessionState: 'REPLYING_TO_CUSTOMER',
        targetCustomerId: existing.customer_id,
        targetTicketId: params.ticketId,
        nowMs,
        gateTable: 'support_tickets',
        gatePkColumn: 'ticket_id',
        gatePkValue: params.ticketId,
        gateMutationToken: mutationToken,
      }),
      auditStmt,
    ]);

    const updatedTicket = (results[0]?.results?.[0] as unknown as SupportTicketRow | undefined) ?? null;
    if (!updatedTicket) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin.role,
        action: 'TICKET_CLAIM_CONFLICT',
        resourceType: 'TICKET',
        resourceId: params.ticketId,
        result: 'CONFLICT',
        reason: `Concurrent claim or stale version (expected=${params.expectedVersion ?? 'any'})`,
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new ConflictError(`Ticket ${params.ticketId} was already claimed or modified concurrently`);
    }

    return updatedTicket;
  },

  async releaseTicket(
    env: Env,
    params: {
      adminId: string;
      ticketId: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<SupportTicketRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin) {
      throw new AuthorizationError('Active administrator required');
    }

    const existing = await ticketRepository.getById(env.DB, params.ticketId);
    if (!existing) {
      throw new NotFoundError(`Ticket ${params.ticketId} not found`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: admin.role,
        action: 'TICKET_RELEASED_KEEP_HUMAN',
        resourceType: 'TICKET',
        resourceId: params.ticketId,
        result: 'SUCCESS',
        beforeState: { status: existing.status, assignedAdminId: existing.assigned_admin_id },
        afterState: { status: 'OPEN', assignedAdminId: null, customerChatModePreserved: 'HUMAN' },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'support_tickets',
        pkColumn: 'ticket_id',
        pkValue: params.ticketId,
        mutationToken,
      }
    );

    // Note: Deliberately does NOT change customer.chat_mode (stays HUMAN until explicit Resolve & Return to AI)
    const results = await executeAtomicBatch(env.DB, [
      ticketRepository.prepareAtomicRelease(env.DB, {
        ticketId: params.ticketId,
        actorAdminId: params.adminId,
        mutationToken,
        nowMs,
      }),
      adminRepository.prepareClearSession(env.DB, params.adminId),
      auditStmt,
    ]);

    const updated = (results[0]?.results?.[0] as unknown as SupportTicketRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(`Ticket ${params.ticketId} could not be released (not assigned to actor or stale)`);
    }
    return updated;
  },

  async resolveTicket(
    env: Env,
    params: {
      adminId: string;
      ticketId: string;
      returnToAi: boolean;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ ticket: SupportTicketRow; chatMode: 'AI' | 'HUMAN' }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin) {
      throw new AuthorizationError('Active administrator required');
    }

    const existing = await ticketRepository.getById(env.DB, params.ticketId);
    if (!existing) {
      throw new NotFoundError(`Ticket ${params.ticketId} not found`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const statements = [
      ticketRepository.prepareAtomicResolve(env.DB, {
        ticketId: params.ticketId,
        actorAdminId: params.adminId,
        mutationToken,
        nowMs,
      }),
      adminRepository.prepareClearSession(env.DB, params.adminId),
    ];

    const queuePayloads: OutboxQueuePayload[] = [];
    if (params.returnToAi) {
      statements.push(
        customerRepository.prepareExplicitReturnToAi(env.DB, {
          customerId: existing.customer_id,
          mutationToken,
          nowMs,
          gateTable: 'support_tickets',
          gatePkColumn: 'ticket_id',
          gatePkValue: params.ticketId,
        })
      );

      const stagedNotice = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `tkt_res_ai:${params.ticketId}:v${existing.version + 1}`,
        eventType: 'RETURN_TO_AI_NOTICE',
        aggregateType: 'TICKET',
        aggregateId: params.ticketId,
        targetChatId: existing.customer_id,
        text: '✅ သင်၏ Support Ticket ပြီးဆုံးသွားပါပြီ။ ယခုမှစ၍ 7777club AI Support မှ ၂၄ နာရီ ပြန်လည်ကူညီပေးပါမည်။',
        correlationId: params.correlationId,
        nowMs,
        gateCondition: {
          table: 'support_tickets',
          pkColumn: 'ticket_id',
          pkValue: params.ticketId,
          mutationToken,
        },
      });
      statements.push(...stagedNotice.statements);
      queuePayloads.push(...stagedNotice.queuePayloads);
    }

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: admin.role,
        action: params.returnToAi ? 'TICKET_RESOLVED_AND_RETURNED_TO_AI' : 'TICKET_RESOLVED_STAY_HUMAN',
        resourceType: 'TICKET',
        resourceId: params.ticketId,
        result: 'SUCCESS',
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'RESOLVED', chatMode: params.returnToAi ? 'AI' : 'HUMAN' },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'support_tickets',
        pkColumn: 'ticket_id',
        pkValue: params.ticketId,
        mutationToken,
      }
    );
    statements.push(auditStmt);

    const results = await executeAtomicBatch(env.DB, statements);
    const updated = (results[0]?.results?.[0] as unknown as SupportTicketRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(`Ticket ${params.ticketId} could not be resolved`);
    }

    if (queuePayloads.length > 0) {
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, queuePayloads);
    }

    return { ticket: updated, chatMode: params.returnToAi ? 'AI' : 'HUMAN' };
  },

  async sendAdminReply(
    env: Env,
    params: {
      adminId: string;
      ticketId: string;
      replyText: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ messageId: string }> {
    const trimmed = params.replyText.trim();
    if (!trimmed) {
      throw new ValidationError('Admin reply text cannot be empty');
    }

    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin || !adminRepository.hasPermission(admin, 'ticket.reply')) {
      throw new AuthorizationError('Active administrator with ticket.reply permission required');
    }

    const ticket = await ticketRepository.getById(env.DB, params.ticketId);
    if (!ticket) {
      throw new NotFoundError(`Ticket ${params.ticketId} not found`);
    }

    if (ticket.assigned_admin_id !== params.adminId && admin.role !== 'SUPER_ADMIN') {
      throw new AuthorizationError('Only the assigned administrator or SUPER_ADMIN can reply on this ticket');
    }

    const mutationToken = generateMutationToken(nowMs);
    const messageId = generatePrefixedId('msg', nowMs);

    const stagedOutbox = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `adm_reply:${messageId}`,
      eventType: 'ADMIN_REPLY',
      aggregateType: 'TICKET',
      aggregateId: ticket.ticket_id,
      targetChatId: ticket.customer_id,
      text: trimmed,
      relatedMessageId: messageId,
      relatedTicketId: ticket.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const auditStmt = await auditRepository.buildInsertStatement(env.DB, {
      actorId: params.adminId,
      actorRole: admin.role,
      action: 'ADMIN_REPLIED_TO_CUSTOMER',
      resourceType: 'TICKET',
      resourceId: ticket.ticket_id,
      result: 'SUCCESS',
      afterState: { messageId, customerId: ticket.customer_id },
      correlationId: params.correlationId,
      sourceUpdateId: params.sourceUpdateId ?? null,
      nowMs,
    });

    const stmts = [
      messageRepository.prepareInsertMessage(env.DB, {
        messageId,
        customerId: ticket.customer_id,
        ticketId: ticket.ticket_id,
        direction: 'OUTBOUND',
        senderRole: 'ADMIN',
        senderId: params.adminId,
        messageType: 'TEXT',
        textContent: trimmed,
        isPotentialSlip: false,
        deliveryStatus: 'PENDING',
        createdAt: nowMs,
      }),
      ...stagedOutbox.statements,
      auditStmt,
    ];

    if (ticket.assigned_admin_id === params.adminId && ticket.status === 'ASSIGNED') {
      stmts.unshift(
        ticketRepository.prepareTouchAdminActivity(env.DB, ticket.ticket_id, params.adminId, mutationToken, nowMs)
      );
    }

    await executeAtomicBatch(env.DB, stmts);
    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedOutbox.queuePayloads);
    return { messageId };
  },
};
