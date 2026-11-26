import type { Env } from '../types/bindings';
import type { DepositRequestRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { depositRepository } from '../repositories/depositRepository';
import { customerRepository } from '../repositories/customerRepository';
import { configRepository } from '../repositories/configRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { messageRepository } from '../repositories/messageRepository';
import { outboxService } from './outboxService';
import {
  notificationService,
  STANDARD_REQUEST_ACK_EN,
  STANDARD_REQUEST_ACK_MY,
} from './notificationService';
import { encodeCallbackData } from '../lib/callbackCodec';
import {
  generateCollisionResistantRequestRef,
  generateMutationToken,
  generatePrefixedId,
} from '../lib/ids';
import { systemClock } from '../lib/clock';
import { escapeHtml } from '../lib/textChunker';
import { AmountInputSchema, containsForbiddenCustomerSecret } from '../schemas/domainSchemas';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';

const WIZARD_TTL_MS = 15 * 60 * 1000;

export const depositService = {
  async startDepositWizard(
    env: Env,
    customerId: string,
    nowMs = systemClock.now(),
    options?: { ticketId?: string | null }
  ): Promise<{
    promptText: string;
    draftToken: string;
    ticketId: string | null;
  }> {
    const [customer, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) {
      throw new NotFoundError(`Customer ${customerId} not found`);
    }
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }

    let boundTicketId: string | null = null;
    if (options?.ticketId !== undefined && options?.ticketId !== null) {
      const explicitTicket = await ticketRepository.getById(env.DB, options.ticketId);
      if (!explicitTicket) {
        throw new NotFoundError(`Ticket ${options.ticketId} not found`);
      }
      if (explicitTicket.customer_id !== customerId) {
        throw new AuthorizationError('Associated ticket does not belong to this customer');
      }
      if (explicitTicket.status !== 'OPEN' && explicitTicket.status !== 'ASSIGNED') {
        throw new ConflictError(`Ticket ${options.ticketId} is ${explicitTicket.status} and cannot accept deposit requests`);
      }
      boundTicketId = explicitTicket.ticket_id;
    } else {
      const activeTickets = await ticketRepository.listActiveByCustomer(env.DB, customerId, 2);
      if (activeTickets.length > 1) {
        throw new ConflictError('Multiple active tickets exist for customer; explicit ticketId is required');
      }
      boundTicketId = activeTickets.length === 1 ? activeTickets[0].ticket_id : null;
    }

    const draftToken = generatePrefixedId('dft', nowMs);
    await customerRepository.upsertSession(env.DB, {
      customer_id: customerId,
      wizard_type: 'DEPOSIT',
      wizard_state: 'DEP_AWAITING_AMOUNT',
      draft_token: draftToken,
      draft_amount: null,
      draft_method_code: null,
      draft_reference_text: null,
      draft_dest_masked: null,
      draft_dest_ciphertext: null,
      draft_dest_iv: null,
      key_version: Number(env.ENCRYPTION_KEY_VERSION ?? '1'),
      target_request_type: null,
      target_request_id: null,
      target_ticket_id: boundTicketId,
      started_at: nowMs,
      expires_at: nowMs + WIZARD_TTL_MS,
      updated_at: nowMs,
    });

    const safeCurrency = escapeHtml(config.currency);
    const promptText =
      customer.language_code === 'en'
        ? `💰 <b>Deposit Request</b>\nEnter deposit amount in ${safeCurrency} (${config.min_deposit_amount.toLocaleString()} - ${config.max_deposit_amount.toLocaleString()}):`
        : `💰 <b>ငွေသွင်းရန် တောင်းဆိုမှု</b>\nသွင်းလိုသော ငွေပမာဏ (${safeCurrency}) ကို ဂဏန်းဖြင့် ရိုက်ထည့်ပါ (${config.min_deposit_amount.toLocaleString()} - ${config.max_deposit_amount.toLocaleString()}):`;

    return { promptText, draftToken, ticketId: boundTicketId };
  },

  async handleAmountInput(
    env: Env,
    customerId: string,
    rawText: string,
    nowMs = systemClock.now()
  ): Promise<{ amount: number; methods: ReturnType<typeof configRepository.parsePaymentMethods>; promptText: string }> {
    const [customer, session, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      customerRepository.getSession(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (!session || session.wizard_type !== 'DEPOSIT' || session.wizard_state !== 'DEP_AWAITING_AMOUNT' || session.expires_at <= nowMs) {
      throw new ConflictError('Deposit wizard session expired or invalid');
    }

    const parsed = AmountInputSchema.safeParse(rawText.trim());
    if (!parsed.success) {
      throw new ValidationError('Please enter a valid positive whole number amount');
    }
    const amount = parsed.data;
    if (amount < config.min_deposit_amount || amount > config.max_deposit_amount) {
      throw new ValidationError(
        `Amount must be between ${config.min_deposit_amount} and ${config.max_deposit_amount} ${config.currency}`
      );
    }

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'DEP_AWAITING_METHOD',
      draft_amount: amount,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) {
      throw new ConflictError('Session modified concurrently');
    }

    const methods = configRepository.parsePaymentMethods(config);
    const safeCurrency = escapeHtml(config.currency);
    const promptText =
      customer.language_code === 'en'
        ? `Amount: <b>${amount.toLocaleString()} ${safeCurrency}</b>\nSelect your payment method:`
        : `ငွေပမာဏ: <b>${amount.toLocaleString()} ${safeCurrency}</b>\nငွေလွှဲမည့် နည်းလမ်းကို ရွေးချယ်ပါ:`;

    return { amount, methods, promptText };
  },

  async handleMethodSelection(
    env: Env,
    customerId: string,
    methodCode: string,
    nowMs = systemClock.now()
  ): Promise<{ promptText: string }> {
    const [customer, session, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      customerRepository.getSession(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (!session || session.wizard_type !== 'DEPOSIT' || session.wizard_state !== 'DEP_AWAITING_METHOD' || session.expires_at <= nowMs) {
      throw new ConflictError('Deposit wizard session expired');
    }

    const methods = configRepository.parsePaymentMethods(config);
    const method = methods.find((m) => m.code === methodCode);
    if (!method) {
      throw new ValidationError(`Unsupported deposit method: ${methodCode}`);
    }

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'DEP_AWAITING_REFERENCE',
      draft_method_code: method.code,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) throw new ConflictError('Session modified concurrently');

    const promptText =
      customer.language_code === 'en'
        ? `Method: <b>${escapeHtml(method.nameEn)}</b>\n${escapeHtml(method.instructionsEn)}\n\nEnter your Transaction Reference ID:`
        : `နည်းလမ်း: <b>${escapeHtml(method.nameMy)}</b>\n${escapeHtml(method.instructionsMy)}\n\nငွေလွှဲလုပ်ငန်းစဉ်အမှတ် (Transaction Ref) ကို ရိုက်ထည့်ပေးပါ:`;

    return { promptText };
  },

  async handleReferenceInput(
    env: Env,
    customerId: string,
    referenceText: string,
    nowMs = systemClock.now()
  ): Promise<{ summaryText: string; draftToken: string }> {
    const [customer, session, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      customerRepository.getSession(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (!session || session.wizard_type !== 'DEPOSIT' || session.wizard_state !== 'DEP_AWAITING_REFERENCE' || session.expires_at <= nowMs) {
      throw new ConflictError('Deposit wizard session expired');
    }

    const trimmedRef = referenceText.trim();
    if (trimmedRef.length < 3 || trimmedRef.length > 120) {
      throw new ValidationError('Transaction reference must be between 3 and 120 characters');
    }

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'DEP_AWAITING_CONFIRM',
      draft_reference_text: trimmedRef,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) throw new ConflictError('Session modified concurrently');

    const safeRef = escapeHtml(trimmedRef);
    const safeCurrency = escapeHtml(config.currency);
    const summaryText =
      customer.language_code === 'en'
        ? `📋 <b>Confirm Deposit Request</b>\nAmount: <b>${session.draft_amount?.toLocaleString()} ${safeCurrency}</b>\nMethod: <b>${escapeHtml(session.draft_method_code ?? '')}</b>\nReference: <code>${safeRef}</code>`
        : `📋 <b>ငွေသွင်းတောင်းဆိုမှု အတည်ပြုရန်</b>\nပမာဏ: <b>${session.draft_amount?.toLocaleString()} ${safeCurrency}</b>\nနည်းလမ်း: <b>${escapeHtml(session.draft_method_code ?? '')}</b>\nလုပ်ငန်းစဉ်အမှတ်: <code>${safeRef}</code>`;

    return { summaryText, draftToken: session.draft_token };
  },

  async confirmSubmission(
    env: Env,
    params: {
      customerId: string;
      draftToken: string;
      ticketId?: string | null;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ deposit: DepositRequestRow; createdNew: boolean }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const existingByToken = await env.DB
      .prepare('SELECT * FROM deposit_requests WHERE idempotency_token = ?1')
      .bind(params.draftToken)
      .first<DepositRequestRow>();
    if (existingByToken) {
      if (existingByToken.customer_id !== params.customerId) {
        throw new AuthorizationError('Deposit draft token does not belong to this customer');
      }
      if (params.ticketId && existingByToken.ticket_id !== params.ticketId) {
        throw new ConflictError('Explicit ticket ID does not match the ticket bound to this deposit request');
      }
      return { deposit: existingByToken, createdNew: false };
    }

    const [customer, config, session] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      configRepository.getActiveConfig(env.DB),
      customerRepository.getSession(env.DB, params.customerId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (
      !session ||
      session.wizard_type !== 'DEPOSIT' ||
      session.wizard_state !== 'DEP_AWAITING_CONFIRM' ||
      session.draft_token !== params.draftToken ||
      session.expires_at <= nowMs
    ) {
      throw new ConflictError('Deposit submission failed validation or session expired');
    }

    const explicitParamTicketId = params.ticketId ?? null;
    const sessionTicketId = session.target_ticket_id ?? null;
    if (explicitParamTicketId && sessionTicketId && explicitParamTicketId !== sessionTicketId) {
      throw new ConflictError('Explicit ticket ID does not match the ticket bound to this deposit workflow');
    }

    const intendedTicketId = explicitParamTicketId ?? sessionTicketId;
    const depositId = generateCollisionResistantRequestRef('DEP', nowMs);
    const mutationToken = generateMutationToken(nowMs);

    const stmts = [];
    let resolvedTicketId: string;

    if (intendedTicketId !== null) {
      const targetTicket = await ticketRepository.getById(env.DB, intendedTicketId);
      if (!targetTicket) {
        throw new NotFoundError(`Associated ticket ${intendedTicketId} not found`);
      }
      if (targetTicket.customer_id !== params.customerId) {
        throw new AuthorizationError('Associated ticket does not belong to this customer');
      }
      if (targetTicket.status !== 'OPEN' && targetTicket.status !== 'ASSIGNED') {
        throw new ConflictError(
          `Associated ticket ${intendedTicketId} is ${targetTicket.status} and cannot accept deposit requests`
        );
      }
      resolvedTicketId = targetTicket.ticket_id;
    } else {
      const activeTickets = await ticketRepository.listActiveByCustomer(env.DB, params.customerId, 2);
      if (activeTickets.length > 1) {
        throw new ConflictError('Multiple active tickets exist for customer; explicit ticketId is required');
      }
      if (activeTickets.length === 1) {
        resolvedTicketId = activeTickets[0].ticket_id;
      } else {
        resolvedTicketId = generatePrefixedId('tkt', nowMs);
        stmts.push(
          ticketRepository.prepareCreateIfNoActiveTicket(env.DB, {
            ticketId: resolvedTicketId,
            customerId: params.customerId,
            ticketType: 'SLIP_DEPOSIT',
            mutationToken,
            nowMs,
          })
        );
      }
    }

    stmts.push(
      depositRepository.prepareAtomicCreateFromSession(env.DB, {
        depositId,
        customerId: params.customerId,
        draftToken: params.draftToken,
        ticketId: resolvedTicketId,
        currency: config.currency,
        mutationToken,
        nowMs,
      }),
      env.DB
        .prepare(
          `DELETE FROM customer_sessions
           WHERE customer_id = ?1
             AND draft_token = ?2
             AND EXISTS (
               SELECT 1 FROM deposit_requests
               WHERE idempotency_token = ?2
                 AND last_mutation_token = ?3
             )`
        )
        .bind(params.customerId, params.draftToken, mutationToken)
    );

    const createResults = await executeAtomicBatch(env.DB, stmts);
    const createdDeposit =
      (createResults[createResults.length - 2]?.results?.[0] as unknown as DepositRequestRow | undefined) ?? null;

    if (!createdDeposit) {
      const retryLookup = await env.DB
        .prepare('SELECT * FROM deposit_requests WHERE idempotency_token = ?1')
        .bind(params.draftToken)
        .first<DepositRequestRow>();
      if (retryLookup) {
        if (retryLookup.customer_id !== params.customerId) {
          throw new AuthorizationError('Deposit draft token does not belong to this customer');
        }
        if (params.ticketId && retryLookup.ticket_id !== params.ticketId) {
          throw new ConflictError('Explicit ticket ID does not match the ticket bound to this deposit request');
        }
        return { deposit: retryLookup, createdNew: false };
      }
      throw new ConflictError('Deposit submission failed validation, ticket check, or session expired');
    }

    const ticketRow = (await ticketRepository.getById(env.DB, createdDeposit.ticket_id))!;
    const ackText =
      customer.language_code === 'en'
        ? `${STANDARD_REQUEST_ACK_EN}\n\nRef: <code>${escapeHtml(createdDeposit.deposit_id)}</code>\nAmount: <b>${createdDeposit.amount.toLocaleString()} ${escapeHtml(createdDeposit.currency)}</b> (${escapeHtml(createdDeposit.method_code)})`
        : `${STANDARD_REQUEST_ACK_MY}\n\nအမှတ်စဉ်: <code>${escapeHtml(createdDeposit.deposit_id)}</code>\nပမာဏ: <b>${createdDeposit.amount.toLocaleString()} ${escapeHtml(createdDeposit.currency)}</b> (${escapeHtml(createdDeposit.method_code)})`;

    const cancelReplyMarkup = {
      inline_keyboard: [
        [
          {
            text: customer.language_code === 'en' ? '❌ Cancel Request' : '❌ တောင်းဆိုမှု ပယ်ဖျက်မည်',
            callback_data: encodeCallbackData({
              namespace: 'dep',
              action: 'creq',
              targetId: createdDeposit.deposit_id,
              version: createdDeposit.version,
            }),
          },
        ],
      ],
    };

    const groupCard = notificationService.buildAdminGroupTicketCard({
      ticket: ticketRow,
      customerFirstName: customer.first_name,
      summaryText: `Deposit ${createdDeposit.deposit_id}: ${createdDeposit.amount} ${createdDeposit.currency} via ${createdDeposit.method_code} (Ref: ${createdDeposit.customer_reference_text ?? 'N/A'})`,
    });

    const stagedCust = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `dep_sub_cust:${createdDeposit.deposit_id}`,
      eventType: 'DEPOSIT_SUBMITTED_ACK',
      aggregateType: 'DEPOSIT',
      aggregateId: createdDeposit.deposit_id,
      targetChatId: params.customerId,
      text: ackText,
      parseMode: 'HTML',
      replyMarkup: cancelReplyMarkup,
      relatedTicketId: createdDeposit.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const stagedGroup = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `dep_sub_grp:${createdDeposit.deposit_id}`,
      eventType: 'GROUP_ALERT',
      aggregateType: 'DEPOSIT',
      aggregateId: createdDeposit.deposit_id,
      targetChatId: env.TELEGRAM_ADMIN_GROUP_ID,
      text: groupCard.text,
      parseMode: 'HTML',
      replyMarkup: groupCard.replyMarkup,
      relatedTicketId: createdDeposit.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [auditStmt, ...stagedCust.statements, ...stagedGroup.statements],
      {
        actorId: params.customerId,
        actorRole: 'CUSTOMER',
        action: 'DEPOSIT_REQUEST_SUBMITTED',
        resourceType: 'DEPOSIT',
        resourceId: createdDeposit.deposit_id,
        result: 'SUCCESS',
        afterState: {
          depositId: createdDeposit.deposit_id,
          amount: createdDeposit.amount,
          currency: createdDeposit.currency,
          methodCode: createdDeposit.method_code,
          status: createdDeposit.status,
        },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      }
    );

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, [
      ...stagedCust.queuePayloads,
      ...stagedGroup.queuePayloads,
    ]);

    return { deposit: createdDeposit, createdNew: true };
  },

  async submitSuperAdminDecision(
    env: Env,
    params: {
      adminId: string;
      depositId: string;
      newStatus: 'UNDER_REVIEW' | 'NEEDS_INFO' | 'APPROVED_MANUAL_CREDITED' | 'REJECTED';
      decisionNote?: string | null;
      adminEvidenceRef?: string | null;
      expectedVersion: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<DepositRequestRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);

    // Enforce SUPER_ADMIN RBAC BEFORE resource lookup to prevent resource enumeration
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_DEPOSIT_DECISION_ATTEMPT',
        resourceType: 'DEPOSIT',
        resourceId: params.depositId,
        result: 'DENIED',
        afterState: { attemptedStatus: params.newStatus },
        reason: 'Only SUPER_ADMIN may decide deposit requests',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial deposit decisions');
    }

    const existing = await depositRepository.getById(env.DB, params.depositId);
    if (!existing) {
      throw new NotFoundError(`Deposit request ${params.depositId} not found`);
    }

    const trimmedEvidence = params.adminEvidenceRef?.trim() ?? null;
    const trimmedNote = params.decisionNote?.trim() ?? null;

    if (params.newStatus === 'APPROVED_MANUAL_CREDITED' && !trimmedEvidence) {
      throw new ValidationError(
        'admin_operation_evidence_ref is mandatory before recording APPROVED_MANUAL_CREDITED'
      );
    }

    if ((params.newStatus === 'REJECTED' || params.newStatus === 'NEEDS_INFO') && !trimmedNote) {
      throw new ValidationError(`decision_note is mandatory when marking deposit as ${params.newStatus}`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const customer = await customerRepository.getById(env.DB, existing.customer_id);
    const lang = customer?.language_code ?? 'my';

    const shouldNotify =
      params.newStatus === 'APPROVED_MANUAL_CREDITED' ||
      params.newStatus === 'REJECTED' ||
      params.newStatus === 'NEEDS_INFO';

    let notifyText = '';
    let replyMarkup: Record<string, unknown> | undefined;
    if (params.newStatus === 'APPROVED_MANUAL_CREDITED') {
      const safeEvidence = escapeHtml(trimmedEvidence ?? '');
      notifyText =
        lang === 'en'
          ? `✅ <b>Deposit Request Confirmed by Admin (Manual Process)</b>\nAn authorized Administrator has verified and recorded manual completion of your deposit request.\nRef: <code>${escapeHtml(existing.deposit_id)}</code>\nAmount: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>\nAdmin Evidence Ref: <code>${safeEvidence}</code>`
          : `✅ <b>ငွေသွင်းတောင်းဆိုမှုကို Admin မှ စစ်ဆေးအတည်ပြုမှတ်တမ်းတင်ပြီးပါပြီ</b>\nတာဝန်ရှိ Admin မှ ပြင်ပတွင် ကိုယ်တိုင်စစ်ဆေးဆောင်ရွက်ပြီးစီးကြောင်း မှတ်တမ်းတင်ပြီးပါပြီ။\nအမှတ်စဉ်: <code>${escapeHtml(existing.deposit_id)}</code>\nပမာဏ: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>\nAdmin မှတ်တမ်းအမှတ်: <code>${safeEvidence}</code>`;
    } else if (params.newStatus === 'REJECTED') {
      const safeNote = escapeHtml(trimmedNote ?? '');
      notifyText =
        lang === 'en'
          ? `❌ <b>Deposit Request Rejected</b>\nRef: <code>${escapeHtml(existing.deposit_id)}</code>\nReason: ${safeNote}`
          : `❌ <b>ငွေသွင်းတောင်းဆိုမှု ပယ်ချခံရပါသည်</b>\nအမှတ်စဉ်: <code>${escapeHtml(existing.deposit_id)}</code>\nအကြောင်းပြချက်: ${safeNote}`;
    } else if (params.newStatus === 'NEEDS_INFO') {
      const safeNote = escapeHtml(trimmedNote ?? '');
      notifyText =
        lang === 'en'
          ? `❓ <b>Additional Information Needed (Deposit)</b>\nRef: <code>${escapeHtml(existing.deposit_id)}</code>\nNote: ${safeNote}`
          : `❓ <b>ငွေသွင်းမှုအတွက် အချက်အလက်ထပ်မံလိုအပ်ပါသည်</b>\nအမှတ်စဉ်: <code>${escapeHtml(existing.deposit_id)}</code>\nမှတ်ချက်: ${safeNote}`;
      replyMarkup = {
        inline_keyboard: [
          [
            {
              text: lang === 'en' ? '📝 Reply with Additional Info' : '📝 အချက်အလက် ပြန်လည်ပေးပို့မည်',
              callback_data: encodeCallbackData({
                namespace: 'dep',
                action: 'rinfo',
                targetId: existing.deposit_id,
                version: params.expectedVersion + 1,
              }),
            },
          ],
        ],
      };
    }

    const stagedNotice = shouldNotify
      ? outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `dep_dec_cust:${existing.deposit_id}:v${params.expectedVersion + 1}`,
          eventType: `DEPOSIT_${params.newStatus}`,
          aggregateType: 'DEPOSIT',
          aggregateId: existing.deposit_id,
          targetChatId: existing.customer_id,
          text: notifyText,
          parseMode: 'HTML',
          replyMarkup,
          relatedTicketId: existing.ticket_id,
          correlationId: params.correlationId,
          nowMs,
          gateCondition: {
            table: 'deposit_requests',
            pkColumn: 'deposit_id',
            pkValue: existing.deposit_id,
            mutationToken,
          },
        })
      : { statements: [], queuePayloads: [] };

    const results = await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [
        depositRepository.prepareSuperAdminDecision(env.DB, {
          depositId: params.depositId,
          actorAdminId: params.adminId,
          newStatus: params.newStatus,
          decisionNote: trimmedNote,
          adminEvidenceRef: trimmedEvidence,
          expectedVersion: params.expectedVersion,
          mutationToken,
          nowMs,
        }),
        auditStmt,
        ...stagedNotice.statements,
      ],
      {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: `DEPOSIT_DECISION_${params.newStatus}`,
        resourceType: 'DEPOSIT',
        resourceId: existing.deposit_id,
        result: 'SUCCESS',
        beforeState: { status: existing.status, version: existing.version },
        afterState: {
          status: params.newStatus,
          version: params.expectedVersion + 1,
          adminOperationEvidenceRef: trimmedEvidence,
          decisionNote: trimmedNote,
        },
        reason: trimmedNote ?? trimmedEvidence,
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'deposit_requests',
        pkColumn: 'deposit_id',
        pkValue: existing.deposit_id,
        mutationToken,
      }
    );

    const updated = (results[0]?.results?.[0] as unknown as DepositRequestRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(
        `Deposit request ${params.depositId} was modified concurrently or is already in a terminal state`
      );
    }

    if (stagedNotice.queuePayloads.length > 0) {
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedNotice.queuePayloads);
    }

    return updated;
  },

  async cancelByCustomer(
    env: Env,
    params: {
      customerId: string;
      depositId: string;
      expectedVersion?: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<DepositRequestRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const customer = await customerRepository.getById(env.DB, params.customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }

    const existing = await depositRepository.getById(env.DB, params.depositId);
    if (!existing) {
      throw new NotFoundError(`Deposit request ${params.depositId} not found`);
    }
    if (existing.customer_id !== params.customerId) {
      throw new AuthorizationError('Only the owning customer may cancel this deposit request');
    }
    if (existing.status === 'CANCELLED_BY_CUSTOMER') {
      return existing;
    }

    const mutationToken = generateMutationToken(nowMs);
    const confirmText =
      customer.language_code === 'en'
        ? `❌ Deposit request <code>${escapeHtml(existing.deposit_id)}</code> has been cancelled.`
        : `❌ ငွေသွင်းတောင်းဆိုမှု <code>${escapeHtml(existing.deposit_id)}</code> ကို ပယ်ဖျက်ပြီးပါပြီ။`;

    const stagedConfirm = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `dep_cncl_cust:${existing.deposit_id}`,
      eventType: 'DEPOSIT_CANCELLED_BY_CUSTOMER',
      aggregateType: 'DEPOSIT',
      aggregateId: existing.deposit_id,
      targetChatId: params.customerId,
      text: confirmText,
      parseMode: 'HTML',
      relatedTicketId: existing.ticket_id,
      correlationId: params.correlationId,
      nowMs,
      gateCondition: {
        table: 'deposit_requests',
        pkColumn: 'deposit_id',
        pkValue: existing.deposit_id,
        mutationToken,
      },
    });

    const results = await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [
        depositRepository.prepareCustomerCancel(env.DB, {
          depositId: params.depositId,
          customerId: params.customerId,
          expectedVersion: params.expectedVersion,
          mutationToken,
          nowMs,
        }),
        auditStmt,
        ...stagedConfirm.statements,
      ],
      {
        actorId: params.customerId,
        actorRole: 'CUSTOMER',
        action: 'DEPOSIT_CANCELLED_BY_CUSTOMER',
        resourceType: 'DEPOSIT',
        resourceId: params.depositId,
        result: 'SUCCESS',
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'CANCELLED_BY_CUSTOMER' },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'deposit_requests',
        pkColumn: 'deposit_id',
        pkValue: params.depositId,
        mutationToken,
      }
    );

    const updated = (results[0]?.results?.[0] as unknown as DepositRequestRow | undefined) ?? null;
    if (!updated) {
      const latest = await depositRepository.getById(env.DB, params.depositId);
      if (latest && latest.customer_id === params.customerId && latest.status === 'CANCELLED_BY_CUSTOMER') {
        return latest;
      }
      throw new ConflictError('Deposit request can only be cancelled while in SUBMITTED state');
    }

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedConfirm.queuePayloads);
    return updated;
  },

  async startNeedsInfoReplySession(
    env: Env,
    params: {
      customerId: string;
      depositId: string;
      expectedVersion?: number;
      nowMs?: number;
    }
  ): Promise<{ promptText: string }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const [customer, existing] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      depositRepository.getById(env.DB, params.depositId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (!existing) throw new NotFoundError(`Deposit request ${params.depositId} not found`);
    if (existing.customer_id !== params.customerId) {
      throw new AuthorizationError('Deposit request does not belong to this customer');
    }
    if (existing.status !== 'NEEDS_INFO') {
      throw new ConflictError('Deposit request is not currently awaiting additional information');
    }
    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new ConflictError('Deposit request status has changed; please refresh');
    }

    await customerRepository.upsertSession(env.DB, {
      customer_id: params.customerId,
      wizard_type: 'NEEDS_INFO_REPLY',
      wizard_state: 'AWAITING_CUSTOMER_INFO_REPLY',
      draft_token: generatePrefixedId('nir', nowMs),
      draft_amount: null,
      draft_method_code: null,
      draft_reference_text: null,
      draft_dest_masked: null,
      draft_dest_ciphertext: null,
      draft_dest_iv: null,
      key_version: Number(env.ENCRYPTION_KEY_VERSION ?? '1'),
      target_request_type: 'DEPOSIT',
      target_request_id: existing.deposit_id,
      started_at: nowMs,
      expires_at: nowMs + WIZARD_TTL_MS,
      updated_at: nowMs,
    });

    const promptText =
      customer.language_code === 'en'
        ? `📝 Please send the requested additional information for Deposit <code>${escapeHtml(existing.deposit_id)}</code>:`
        : `📝 ငွေသွင်းတောင်းဆိုမှု <code>${escapeHtml(existing.deposit_id)}</code> အတွက် Admin မှ တောင်းဆိုထားသော အချက်အလက်ကို ပေးပို့ပေးပါ:`;

    return { promptText };
  },

  async submitNeedsInfoReply(
    env: Env,
    params: {
      customerId: string;
      replyText: string;
      telegramMessageId: number;
      updateId: number;
      correlationId: string;
      nowMs?: number;
    }
  ): Promise<{ depositId: string }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const [customer, session] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      customerRepository.getSession(env.DB, params.customerId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (
      !session ||
      session.wizard_type !== 'NEEDS_INFO_REPLY' ||
      session.wizard_state !== 'AWAITING_CUSTOMER_INFO_REPLY' ||
      session.target_request_type !== 'DEPOSIT' ||
      !session.target_request_id ||
      session.expires_at <= nowMs
    ) {
      throw new ConflictError('Additional info reply session expired or invalid');
    }

    const trimmed = params.replyText.trim();
    if (trimmed.length < 1 || trimmed.length > 1500) {
      throw new ValidationError('Reply text must be between 1 and 1500 characters');
    }
    if (containsForbiddenCustomerSecret(trimmed)) {
      throw new ValidationError(
        'SECURITY BLOCK: Inputs containing Password, PIN, or OTP are strictly rejected.'
      );
    }

    const existing = await depositRepository.getById(env.DB, session.target_request_id);
    if (!existing || existing.customer_id !== params.customerId) {
      await customerRepository.clearSession(env.DB, params.customerId);
      throw new NotFoundError('Referenced deposit request was not found');
    }
    if (existing.status !== 'NEEDS_INFO') {
      await customerRepository.clearSession(env.DB, params.customerId);
      throw new ConflictError('Deposit request is no longer in NEEDS_INFO state');
    }

    const ticket = await ticketRepository.getById(env.DB, existing.ticket_id);
    const targetAdminChat = ticket?.assigned_admin_id ?? env.TELEGRAM_ADMIN_GROUP_ID;
    const messageId = generatePrefixedId('msg', nowMs);

    const stagedCustAck = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `dep_ninfo_ack:${existing.deposit_id}:${params.updateId}`,
      eventType: 'DEPOSIT_NEEDS_INFO_REPLIED_ACK',
      aggregateType: 'DEPOSIT',
      aggregateId: existing.deposit_id,
      targetChatId: params.customerId,
      text:
        customer.language_code === 'en'
          ? `✅ Your additional information for Deposit <code>${escapeHtml(existing.deposit_id)}</code> has been sent to the Admin team for review.`
          : `✅ ငွေသွင်းတောင်းဆိုမှု <code>${escapeHtml(existing.deposit_id)}</code> အတွက် သင်ပေးပို့သော အချက်အလက်ကို Admin ထံ ပို့ဆောင်ပြီးပါပြီ။`,
      parseMode: 'HTML',
      relatedTicketId: existing.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const stagedAdminAlert = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `dep_ninfo_adm:${existing.deposit_id}:${params.updateId}`,
      eventType: 'DEPOSIT_NEEDS_INFO_CUSTOMER_REPLY',
      aggregateType: 'DEPOSIT',
      aggregateId: existing.deposit_id,
      targetChatId: targetAdminChat,
      text: `📩 <b>Customer Info Reply (Deposit <code>${escapeHtml(existing.deposit_id)}</code>)</b>\n• Customer: ${escapeHtml(customer.first_name)} (<code>${escapeHtml(customer.telegram_user_id)}</code>)\n• Reply: ${escapeHtml(trimmed)}`,
      parseMode: 'HTML',
      relatedTicketId: existing.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [
        messageRepository.prepareInsertMessage(env.DB, {
          messageId,
          customerId: params.customerId,
          telegramMessageId: params.telegramMessageId,
          updateId: params.updateId,
          ticketId: existing.ticket_id,
          direction: 'INBOUND',
          senderRole: 'USER',
          senderId: params.customerId,
          messageType: 'TEXT',
          textContent: trimmed,
          isPotentialSlip: false,
          includeInAiContext: false,
          deliveryStatus: 'RECEIVED',
          createdAt: nowMs,
        }),
        auditStmt,
        ...stagedCustAck.statements,
        ...stagedAdminAlert.statements,
      ],
      {
        actorId: params.customerId,
        actorRole: 'CUSTOMER',
        action: 'DEPOSIT_NEEDS_INFO_CUSTOMER_REPLIED',
        resourceType: 'DEPOSIT',
        resourceId: existing.deposit_id,
        result: 'SUCCESS',
        afterState: { messageId, status: existing.status },
        correlationId: params.correlationId,
        sourceUpdateId: params.updateId,
        nowMs,
      }
    );

    await customerRepository.clearSession(env.DB, params.customerId);
    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, [
      ...stagedCustAck.queuePayloads,
      ...stagedAdminAlert.queuePayloads,
    ]);

    return { depositId: existing.deposit_id };
  },

  async formatCustomerStatus(env: Env, customerId: string): Promise<string> {
    const [customer, rows] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      depositRepository.listByCustomer(env.DB, customerId, 5),
    ]);
    const lang = customer?.language_code ?? 'my';
    if (rows.length === 0) {
      return lang === 'en'
        ? '📭 You have no recent deposit requests.'
        : '📭 လက်ရှိတွင် ငွေသွင်းတောင်းဆိုမှု မှတ်တမ်း မရှိသေးပါ။';
    }
    const header =
      lang === 'en'
        ? '📥 <b>Your Recent Deposit Requests</b>\n\n'
        : '📥 <b>သင်၏ နောက်ဆုံး ငွေသွင်းတောင်းဆိုမှုများ</b>\n\n';
    return (
      header +
      rows
        .map(
          (r) =>
            `• <code>${escapeHtml(r.deposit_id)}</code> — <b>${r.amount.toLocaleString()} ${escapeHtml(r.currency)}</b> (${escapeHtml(r.method_code)}) — <b>${escapeHtml(r.status)}</b>`
        )
        .join('\n')
    );
  },
};
