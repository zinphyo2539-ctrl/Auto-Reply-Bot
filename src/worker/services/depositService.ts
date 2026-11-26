import type { Env } from '../types/bindings';
import type { DepositRequestRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { depositRepository } from '../repositories/depositRepository';
import { customerRepository } from '../repositories/customerRepository';
import { configRepository } from '../repositories/configRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { outboxService } from './outboxService';
import {
  notificationService,
  STANDARD_REQUEST_ACK_EN,
  STANDARD_REQUEST_ACK_MY,
} from './notificationService';
import {
  generateCollisionResistantRequestRef,
  generateMutationToken,
  generatePrefixedId,
} from '../lib/ids';
import { systemClock } from '../lib/clock';
import { AmountInputSchema } from '../schemas/domainSchemas';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';

const WIZARD_TTL_MS = 15 * 60 * 1000;

export const depositService = {
  async startDepositWizard(env: Env, customerId: string, nowMs = systemClock.now()): Promise<{
    promptText: string;
    draftToken: string;
  }> {
    const [customer, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) {
      throw new NotFoundError(`Customer ${customerId} not found`);
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
      started_at: nowMs,
      expires_at: nowMs + WIZARD_TTL_MS,
      updated_at: nowMs,
    });

    const promptText =
      customer.language_code === 'en'
        ? `💰 <b>Deposit Request</b>\nEnter deposit amount in ${config.currency} (${config.min_deposit_amount.toLocaleString()} - ${config.max_deposit_amount.toLocaleString()}):`
        : `💰 <b>ငွေသွင်းရန် တောင်းဆိုမှု</b>\nသွင်းလိုသော ငွေပမာဏ (${config.currency}) ကို ဂဏန်းဖြင့် ရိုက်ထည့်ပါ (${config.min_deposit_amount.toLocaleString()} - ${config.max_deposit_amount.toLocaleString()}):`;

    return { promptText, draftToken };
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
    const promptText =
      customer.language_code === 'en'
        ? `Amount: <b>${amount.toLocaleString()} ${config.currency}</b>\nSelect your payment method:`
        : `ငွေပမာဏ: <b>${amount.toLocaleString()} ${config.currency}</b>\nငွေလွှဲမည့် နည်းလမ်းကို ရွေးချယ်ပါ:`;

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
        ? `Method: <b>${method.nameEn}</b>\n${method.instructionsEn}\n\nEnter your Transaction Reference ID:`
        : `နည်းလမ်း: <b>${method.nameMy}</b>\n${method.instructionsMy}\n\nငွေလွှဲလုပ်ငန်းစဉ်အမှတ် (Transaction Ref) ကို ရိုက်ထည့်ပေးပါ:`;

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

    const summaryText =
      customer.language_code === 'en'
        ? `📋 <b>Confirm Deposit Request</b>\nAmount: <b>${session.draft_amount?.toLocaleString()} ${config.currency}</b>\nMethod: <b>${session.draft_method_code}</b>\nReference: <code>${trimmedRef}</code>`
        : `📋 <b>ငွေသွင်းတောင်းဆိုမှု အတည်ပြုရန်</b>\nပမာဏ: <b>${session.draft_amount?.toLocaleString()} ${config.currency}</b>\nနည်းလမ်း: <b>${session.draft_method_code}</b>\nလုပ်ငန်းစဉ်အမှတ်: <code>${trimmedRef}</code>`;

    return { summaryText, draftToken: session.draft_token };
  },

  async confirmSubmission(
    env: Env,
    params: {
      customerId: string;
      draftToken: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ deposit: DepositRequestRow; createdNew: boolean }> {
    const nowMs = params.nowMs ?? systemClock.now();
    // Idempotency check by draftToken
    const existingByToken = await env.DB
      .prepare('SELECT * FROM deposit_requests WHERE idempotency_token = ?1')
      .bind(params.draftToken)
      .first<DepositRequestRow>();
    if (existingByToken) {
      return { deposit: existingByToken, createdNew: false };
    }

    const [customer, config, activeTicket] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      configRepository.getActiveConfig(env.DB),
      ticketRepository.findActiveByCustomer(env.DB, params.customerId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');

    const depositId = generateCollisionResistantRequestRef('DEP', nowMs);
    const fallbackTicketId = activeTicket ? activeTicket.ticket_id : generatePrefixedId('tkt', nowMs);
    const mutationToken = generateMutationToken(nowMs);

    const stmts = [];
    if (!activeTicket) {
      stmts.push(
        ticketRepository.prepareCreateIfNoActiveTicket(env.DB, {
          ticketId: fallbackTicketId,
          customerId: params.customerId,
          ticketType: 'SLIP_DEPOSIT',
          mutationToken,
          nowMs,
        })
      );
    }

    stmts.push(
      depositRepository.prepareAtomicCreateFromSession(env.DB, {
        depositId,
        customerId: params.customerId,
        draftToken: params.draftToken,
        ticketId: fallbackTicketId,
        currency: config.currency,
        mutationToken,
        nowMs,
      })
    );

    const createResults = await executeAtomicBatch(env.DB, stmts);
    const createdDeposit =
      (createResults[createResults.length - 1]?.results?.[0] as unknown as DepositRequestRow | undefined) ?? null;

    if (!createdDeposit) {
      const retryLookup = await env.DB
        .prepare('SELECT * FROM deposit_requests WHERE idempotency_token = ?1')
        .bind(params.draftToken)
        .first<DepositRequestRow>();
      if (retryLookup) {
        return { deposit: retryLookup, createdNew: false };
      }
      throw new ConflictError('Deposit submission failed validation or session expired');
    }

    await customerRepository.clearSession(env.DB, params.customerId);

    const ticketRow = (await ticketRepository.getById(env.DB, createdDeposit.ticket_id))!;
    const ackText =
      customer.language_code === 'en'
        ? `${STANDARD_REQUEST_ACK_EN}\n\nRef: <code>${createdDeposit.deposit_id}</code>\nAmount: <b>${createdDeposit.amount.toLocaleString()} ${createdDeposit.currency}</b> (${createdDeposit.method_code})`
        : `${STANDARD_REQUEST_ACK_MY}\n\nအမှတ်စဉ်: <code>${createdDeposit.deposit_id}</code>\nပမာဏ: <b>${createdDeposit.amount.toLocaleString()} ${createdDeposit.currency}</b> (${createdDeposit.method_code})`;

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

    const auditStmt = await auditRepository.buildInsertStatement(env.DB, {
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
    });

    await executeAtomicBatch(env.DB, [
      auditStmt,
      ...stagedCust.statements,
      ...stagedGroup.statements,
    ]);

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
    const existing = await depositRepository.getById(env.DB, params.depositId);
    if (!existing) {
      throw new NotFoundError(`Deposit request ${params.depositId} not found`);
    }

    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_DEPOSIT_DECISION_ATTEMPT',
        resourceType: 'DEPOSIT',
        resourceId: params.depositId,
        result: 'DENIED',
        beforeState: { status: existing.status, version: existing.version },
        afterState: { attemptedStatus: params.newStatus },
        reason: 'Only SUPER_ADMIN may decide deposit requests',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial deposit decisions');
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
    if (params.newStatus === 'APPROVED_MANUAL_CREDITED') {
      notifyText =
        lang === 'en'
          ? `✅ <b>Deposit Credited</b>\nRef: <code>${existing.deposit_id}</code>\nAmount: <b>${existing.amount.toLocaleString()} ${existing.currency}</b>\nAdmin Evidence Ref: <code>${trimmedEvidence}</code>`
          : `✅ <b>ငွေသွင်းခြင်း အောင်မြင်စွာ ထည့်သွင်းပြီးပါပြီ</b>\nအမှတ်စဉ်: <code>${existing.deposit_id}</code>\nပမာဏ: <b>${existing.amount.toLocaleString()} ${existing.currency}</b>\nAdmin မှတ်တမ်းအမှတ်: <code>${trimmedEvidence}</code>`;
    } else if (params.newStatus === 'REJECTED') {
      notifyText =
        lang === 'en'
          ? `❌ <b>Deposit Request Rejected</b>\nRef: <code>${existing.deposit_id}</code>\nReason: ${trimmedNote}`
          : `❌ <b>ငွေသွင်းတောင်းဆိုမှု ပယ်ချခံရပါသည်</b>\nအမှတ်စဉ်: <code>${existing.deposit_id}</code>\nအကြောင်းပြချက်: ${trimmedNote}`;
    } else if (params.newStatus === 'NEEDS_INFO') {
      notifyText =
        lang === 'en'
          ? `❓ <b>Additional Information Needed (Deposit)</b>\nRef: <code>${existing.deposit_id}</code>\nNote: ${trimmedNote}`
          : `❓ <b>ငွေသွင်းမှုအတွက် အချက်အလက်ထပ်မံလိုအပ်ပါသည်</b>\nအမှတ်စဉ်: <code>${existing.deposit_id}</code>\nမှတ်ချက်: ${trimmedNote}`;
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

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
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

    const results = await executeAtomicBatch(env.DB, [
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
    ]);

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
            `• <code>${r.deposit_id}</code> — <b>${r.amount.toLocaleString()} ${r.currency}</b> (${r.method_code}) — <b>${r.status}</b>`
        )
        .join('\n')
    );
  },
};
