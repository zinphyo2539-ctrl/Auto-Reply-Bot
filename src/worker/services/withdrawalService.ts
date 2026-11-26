import type { Env } from '../types/bindings';
import type { WithdrawalRequestRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { withdrawalRepository } from '../repositories/withdrawalRepository';
import { customerRepository } from '../repositories/customerRepository';
import { configRepository } from '../repositories/configRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { outboxService } from './outboxService';
import {
  ANTI_PHISHING_WARNING_EN,
  ANTI_PHISHING_WARNING_MY,
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
import { decryptPayoutDestination, encryptPayoutDestination } from '../lib/crypto';
import { AmountInputSchema, containsForbiddenCustomerSecret } from '../schemas/domainSchemas';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';

const WIZARD_TTL_MS = 15 * 60 * 1000;

export const withdrawalService = {
  async startWithdrawalWizard(env: Env, customerId: string, nowMs = systemClock.now()): Promise<{
    promptText: string;
    draftToken: string;
  }> {
    const [customer, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');

    const draftToken = generatePrefixedId('wdt', nowMs);
    const keyVersion = Number(env.ENCRYPTION_KEY_VERSION ?? '1');

    await customerRepository.upsertSession(env.DB, {
      customer_id: customerId,
      wizard_type: 'WITHDRAWAL',
      wizard_state: 'WD_AWAITING_AMOUNT',
      draft_token: draftToken,
      draft_amount: null,
      draft_method_code: null,
      draft_reference_text: null,
      draft_dest_masked: null,
      draft_dest_ciphertext: null,
      draft_dest_iv: null,
      key_version: keyVersion,
      target_request_type: null,
      target_request_id: null,
      started_at: nowMs,
      expires_at: nowMs + WIZARD_TTL_MS,
      updated_at: nowMs,
    });

    const promptText =
      customer.language_code === 'en'
        ? `💸 <b>Withdrawal Request</b>\nEnter withdrawal amount in ${config.currency} (${config.min_withdrawal_amount.toLocaleString()} - ${config.max_withdrawal_amount.toLocaleString()}):\n${ANTI_PHISHING_WARNING_EN}`
        : `💸 <b>ငွေထုတ်ရန် တောင်းဆိုမှု</b>\nထုတ်ယူလိုသော ငွေပမာဏ (${config.currency}) ကို ဂဏန်းဖြင့် ရိုက်ထည့်ပါ (${config.min_withdrawal_amount.toLocaleString()} - ${config.max_withdrawal_amount.toLocaleString()}):\n${ANTI_PHISHING_WARNING_MY}`;

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
    if (!session || session.wizard_type !== 'WITHDRAWAL' || session.wizard_state !== 'WD_AWAITING_AMOUNT' || session.expires_at <= nowMs) {
      throw new ConflictError('Withdrawal wizard session expired');
    }

    const parsed = AmountInputSchema.safeParse(rawText.trim());
    if (!parsed.success) {
      throw new ValidationError('Please enter a valid positive whole number amount');
    }
    const amount = parsed.data;
    if (amount < config.min_withdrawal_amount || amount > config.max_withdrawal_amount) {
      throw new ValidationError(
        `Amount must be between ${config.min_withdrawal_amount} and ${config.max_withdrawal_amount} ${config.currency}`
      );
    }

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'WD_AWAITING_METHOD',
      draft_amount: amount,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) throw new ConflictError('Session modified concurrently');

    const methods = configRepository.parsePaymentMethods(config);
    const promptText =
      customer.language_code === 'en'
        ? `Withdrawal Amount: <b>${amount.toLocaleString()} ${config.currency}</b>\nSelect your payout method:`
        : `ငွေထုတ်ပမာဏ: <b>${amount.toLocaleString()} ${config.currency}</b>\nငွေလက်ခံမည့် နည်းလမ်းကို ရွေးချယ်ပါ:`;

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
    if (!session || session.wizard_type !== 'WITHDRAWAL' || session.wizard_state !== 'WD_AWAITING_METHOD' || session.expires_at <= nowMs) {
      throw new ConflictError('Withdrawal wizard session expired');
    }

    const methods = configRepository.parsePaymentMethods(config);
    const method = methods.find((m) => m.code === methodCode);
    if (!method) {
      throw new ValidationError(`Unsupported withdrawal method: ${methodCode}`);
    }

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'WD_AWAITING_DESTINATION',
      draft_method_code: method.code,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) throw new ConflictError('Session modified concurrently');

    const promptText =
      customer.language_code === 'en'
        ? `Method: <b>${method.nameEn}</b>\nEnter ONLY your Account Name and Account/Phone Number:\n${ANTI_PHISHING_WARNING_EN}`
        : `နည်းလမ်း: <b>${method.nameMy}</b>\nငွေလက်ခံမည့် အကောင့်အမည် နှင့် အကောင့်/ဖုန်းနံပါတ်ကိုသာ ရိုက်ထည့်ပါ:\n${ANTI_PHISHING_WARNING_MY}`;

    return { promptText };
  },

  async handleDestinationInput(
    env: Env,
    customerId: string,
    rawDestination: string,
    nowMs = systemClock.now()
  ): Promise<{ summaryText: string; maskedDestination: string; draftToken: string }> {
    const [customer, session, config] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      customerRepository.getSession(env.DB, customerId),
      configRepository.getActiveConfig(env.DB),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!session || session.wizard_type !== 'WITHDRAWAL' || session.wizard_state !== 'WD_AWAITING_DESTINATION' || session.expires_at <= nowMs) {
      throw new ConflictError('Withdrawal wizard session expired');
    }

    const trimmed = rawDestination.trim();
    if (trimmed.length < 5 || trimmed.length > 180) {
      throw new ValidationError('Payout destination must be between 5 and 180 characters');
    }

    if (containsForbiddenCustomerSecret(trimmed)) {
      throw new ValidationError(
        'SECURITY BLOCK: Inputs containing Password, PIN, or OTP are strictly rejected. Enter only your payout account name and number.'
      );
    }

    const keyVersion = Number(env.ENCRYPTION_KEY_VERSION ?? '1');
    const encrypted = await encryptPayoutDestination(trimmed, env.WITHDRAWAL_PII_ENCRYPTION_KEY, {
      customerId,
      methodCode: session.draft_method_code!,
      keyVersion,
    });

    const updated = await customerRepository.upsertSession(env.DB, {
      ...session,
      wizard_state: 'WD_AWAITING_CONFIRM',
      draft_dest_masked: encrypted.masked,
      draft_dest_ciphertext: encrypted.ciphertext,
      draft_dest_iv: encrypted.iv,
      key_version: encrypted.keyVersion,
      updated_at: nowMs,
      expectedVersion: session.wizard_version,
    });
    if (!updated) throw new ConflictError('Session modified concurrently');

    const summaryText =
      customer.language_code === 'en'
        ? `📋 <b>Confirm Withdrawal Request</b>\nAmount: <b>${session.draft_amount?.toLocaleString()} ${config.currency}</b>\nMethod: <b>${session.draft_method_code}</b>\nDestination: <code>${encrypted.masked}</code>`
        : `📋 <b>ငွေထုတ်တောင်းဆိုမှု အတည်ပြုရန်</b>\nပမာဏ: <b>${session.draft_amount?.toLocaleString()} ${config.currency}</b>\nနည်းလမ်း: <b>${session.draft_method_code}</b>\nလက်ခံမည့်အကောင့်: <code>${encrypted.masked}</code>`;

    return { summaryText, maskedDestination: encrypted.masked, draftToken: session.draft_token };
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
  ): Promise<{ withdrawal: WithdrawalRequestRow; createdNew: boolean }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const existingByToken = await env.DB
      .prepare('SELECT * FROM withdrawal_requests WHERE idempotency_token = ?1')
      .bind(params.draftToken)
      .first<WithdrawalRequestRow>();
    if (existingByToken) {
      return { withdrawal: existingByToken, createdNew: false };
    }

    const [customer, config, activeTicket] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      configRepository.getActiveConfig(env.DB),
      ticketRepository.findActiveByCustomer(env.DB, params.customerId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');

    const withdrawalId = generateCollisionResistantRequestRef('WD', nowMs);
    const fallbackTicketId = activeTicket ? activeTicket.ticket_id : generatePrefixedId('tkt', nowMs);
    const mutationToken = generateMutationToken(nowMs);

    const stmts = [];
    if (!activeTicket) {
      stmts.push(
        ticketRepository.prepareCreateIfNoActiveTicket(env.DB, {
          ticketId: fallbackTicketId,
          customerId: params.customerId,
          ticketType: 'WITHDRAWAL',
          mutationToken,
          nowMs,
        })
      );
    }

    stmts.push(
      withdrawalRepository.prepareAtomicCreateFromSession(env.DB, {
        withdrawalId,
        customerId: params.customerId,
        draftToken: params.draftToken,
        ticketId: fallbackTicketId,
        currency: config.currency,
        mutationToken,
        nowMs,
      })
    );

    const createResults = await executeAtomicBatch(env.DB, stmts);
    const createdWd =
      (createResults[createResults.length - 1]?.results?.[0] as unknown as WithdrawalRequestRow | undefined) ?? null;

    if (!createdWd) {
      const retryLookup = await env.DB
        .prepare('SELECT * FROM withdrawal_requests WHERE idempotency_token = ?1')
        .bind(params.draftToken)
        .first<WithdrawalRequestRow>();
      if (retryLookup) {
        return { withdrawal: retryLookup, createdNew: false };
      }
      throw new ConflictError('Withdrawal submission failed validation or session expired');
    }

    await customerRepository.clearSession(env.DB, params.customerId);

    const ticketRow = (await ticketRepository.getById(env.DB, createdWd.ticket_id))!;
    const ackText =
      customer.language_code === 'en'
        ? `${STANDARD_REQUEST_ACK_EN}\n\nRef: <code>${createdWd.withdrawal_id}</code>\nAmount: <b>${createdWd.amount.toLocaleString()} ${createdWd.currency}</b> (${createdWd.method_code})\nDestination: <code>${createdWd.destination_masked}</code>`
        : `${STANDARD_REQUEST_ACK_MY}\n\nအမှတ်စဉ်: <code>${createdWd.withdrawal_id}</code>\nပမာဏ: <b>${createdWd.amount.toLocaleString()} ${createdWd.currency}</b> (${createdWd.method_code})\nလက်ခံမည့်အကောင့်: <code>${createdWd.destination_masked}</code>`;

    // Group notification strictly uses destination_masked ONLY (never plaintext PII)
    const groupCard = notificationService.buildAdminGroupTicketCard({
      ticket: ticketRow,
      customerFirstName: customer.first_name,
      summaryText: `Withdrawal ${createdWd.withdrawal_id}: ${createdWd.amount} ${createdWd.currency} via ${createdWd.method_code} (Dest: ${createdWd.destination_masked})`,
    });

    const stagedCust = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `wd_sub_cust:${createdWd.withdrawal_id}`,
      eventType: 'WITHDRAWAL_SUBMITTED_ACK',
      aggregateType: 'WITHDRAWAL',
      aggregateId: createdWd.withdrawal_id,
      targetChatId: params.customerId,
      text: ackText,
      parseMode: 'HTML',
      relatedTicketId: createdWd.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const stagedGroup = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `wd_sub_grp:${createdWd.withdrawal_id}`,
      eventType: 'GROUP_ALERT',
      aggregateType: 'WITHDRAWAL',
      aggregateId: createdWd.withdrawal_id,
      targetChatId: env.TELEGRAM_ADMIN_GROUP_ID,
      text: groupCard.text,
      parseMode: 'HTML',
      replyMarkup: groupCard.replyMarkup,
      relatedTicketId: createdWd.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const auditStmt = await auditRepository.buildInsertStatement(env.DB, {
      actorId: params.customerId,
      actorRole: 'CUSTOMER',
      action: 'WITHDRAWAL_REQUEST_SUBMITTED',
      resourceType: 'WITHDRAWAL',
      resourceId: createdWd.withdrawal_id,
      result: 'SUCCESS',
      afterState: {
        withdrawalId: createdWd.withdrawal_id,
        amount: createdWd.amount,
        currency: createdWd.currency,
        methodCode: createdWd.method_code,
        destinationMasked: createdWd.destination_masked,
        status: createdWd.status,
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

    return { withdrawal: createdWd, createdNew: true };
  },

  /**
   * Fail-closed Audit-Before-Decrypt in private SUPER_ADMIN chat ONLY.
   */
  async decryptDestinationForSuperAdmin(
    env: Env,
    params: {
      adminId: string;
      withdrawalId: string;
      requestChatId: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ plaintextDestination: string; withdrawalId: string }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    const withdrawal = await withdrawalRepository.getById(env.DB, params.withdrawalId);
    if (!withdrawal) {
      throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
    }

    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_WITHDRAWAL_PII_DECRYPT_ATTEMPT',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        reason: 'Only SUPER_ADMIN may decrypt withdrawal payout destination',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to decrypt withdrawal payout destination');
    }

    if (params.requestChatId === env.TELEGRAM_ADMIN_GROUP_ID || params.requestChatId.startsWith('-')) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: 'GROUP_CHAT_WITHDRAWAL_PII_DECRYPT_BLOCKED',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        reason: 'Payout destination decryption is strictly forbidden in group chats',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Payout destination cannot be decrypted inside a group chat. Use private bot chat.');
    }

    if (withdrawal.destination_ciphertext === 'REDACTED' || withdrawal.destination_iv === 'REDACTED') {
      throw new ConflictError('Payout destination ciphertext has already been redacted');
    }

    // FAIL-CLOSED AUDIT-BEFORE-DECRYPT: Persist immutable audit record BEFORE running AES-GCM decrypt
    await auditRepository.appendImmediate(env.DB, {
      actorId: params.adminId,
      actorRole: 'SUPER_ADMIN',
      action: 'WITHDRAWAL_DESTINATION_PII_DECRYPTED',
      resourceType: 'WITHDRAWAL',
      resourceId: params.withdrawalId,
      result: 'SUCCESS',
      afterState: {
        keyVersion: withdrawal.encryption_key_version,
        deliveredToPrivateChatId: params.requestChatId,
      },
      correlationId: params.correlationId,
      sourceUpdateId: params.sourceUpdateId ?? null,
      nowMs,
    });

    const plaintext = await decryptPayoutDestination(
      withdrawal.destination_ciphertext,
      withdrawal.destination_iv,
      {
        customerId: withdrawal.customer_id,
        methodCode: withdrawal.method_code,
        keyVersion: withdrawal.encryption_key_version,
      },
      {
        currentKey: env.WITHDRAWAL_PII_ENCRYPTION_KEY,
        previousKey: env.WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS,
        currentKeyVersion: Number(env.ENCRYPTION_KEY_VERSION ?? '1'),
      }
    );

    return { plaintextDestination: plaintext, withdrawalId: withdrawal.withdrawal_id };
  },

  async submitSuperAdminDecision(
    env: Env,
    params: {
      adminId: string;
      withdrawalId: string;
      newStatus: 'UNDER_REVIEW' | 'NEEDS_INFO' | 'APPROVED_FOR_PAYOUT' | 'PAID_RECORDED' | 'REJECTED';
      decisionNote?: string | null;
      paymentEvidenceRef?: string | null;
      expectedVersion: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<WithdrawalRequestRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    const existing = await withdrawalRepository.getById(env.DB, params.withdrawalId);
    if (!existing) {
      throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
    }

    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_WITHDRAWAL_DECISION_ATTEMPT',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        beforeState: { status: existing.status, version: existing.version },
        afterState: { attemptedStatus: params.newStatus },
        reason: 'Only SUPER_ADMIN may decide withdrawal requests',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial withdrawal decisions');
    }

    const trimmedEvidence = params.paymentEvidenceRef?.trim() ?? null;
    const trimmedNote = params.decisionNote?.trim() ?? null;

    if (params.newStatus === 'PAID_RECORDED' && !trimmedEvidence) {
      throw new ValidationError('payment_evidence_ref is mandatory before recording PAID_RECORDED');
    }

    if ((params.newStatus === 'REJECTED' || params.newStatus === 'NEEDS_INFO') && !trimmedNote) {
      throw new ValidationError(`decision_note is mandatory when marking withdrawal as ${params.newStatus}`);
    }

    const mutationToken = generateMutationToken(nowMs);
    const customer = await customerRepository.getById(env.DB, existing.customer_id);
    const lang = customer?.language_code ?? 'my';

    const shouldNotify =
      params.newStatus === 'PAID_RECORDED' ||
      params.newStatus === 'REJECTED' ||
      params.newStatus === 'NEEDS_INFO';

    let notifyText = '';
    if (params.newStatus === 'PAID_RECORDED') {
      notifyText =
        lang === 'en'
          ? `✅ <b>Withdrawal Paid</b>\nRef: <code>${existing.withdrawal_id}</code>\nAmount: <b>${existing.amount.toLocaleString()} ${existing.currency}</b>\nPayment Evidence Ref: <code>${trimmedEvidence}</code>`
          : `✅ <b>ငွေထုတ်ပေးချေမှု အောင်မြင်ပါသည်</b>\nအမှတ်စဉ်: <code>${existing.withdrawal_id}</code>\nပမာဏ: <b>${existing.amount.toLocaleString()} ${existing.currency}</b>\nငွေလွှဲအထောက်အထား: <code>${trimmedEvidence}</code>`;
    } else if (params.newStatus === 'REJECTED') {
      notifyText =
        lang === 'en'
          ? `❌ <b>Withdrawal Request Rejected</b>\nRef: <code>${existing.withdrawal_id}</code>\nReason: ${trimmedNote}`
          : `❌ <b>ငွေထုတ်တောင်းဆိုမှု ပယ်ချခံရပါသည်</b>\nအမှတ်စဉ်: <code>${existing.withdrawal_id}</code>\nအကြောင်းပြချက်: ${trimmedNote}`;
    } else if (params.newStatus === 'NEEDS_INFO') {
      notifyText =
        lang === 'en'
          ? `❓ <b>Additional Information Needed (Withdrawal)</b>\nRef: <code>${existing.withdrawal_id}</code>\nNote: ${trimmedNote}`
          : `❓ <b>ငွေထုတ်မှုအတွက် အချက်အလက်ထပ်မံလိုအပ်ပါသည်</b>\nအမှတ်စဉ်: <code>${existing.withdrawal_id}</code>\nမှတ်ချက်: ${trimmedNote}`;
    }

    const stagedNotice = shouldNotify
      ? outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `wd_dec_cust:${existing.withdrawal_id}:v${params.expectedVersion + 1}`,
          eventType: `WITHDRAWAL_${params.newStatus}`,
          aggregateType: 'WITHDRAWAL',
          aggregateId: existing.withdrawal_id,
          targetChatId: existing.customer_id,
          text: notifyText,
          parseMode: 'HTML',
          relatedTicketId: existing.ticket_id,
          correlationId: params.correlationId,
          nowMs,
          gateCondition: {
            table: 'withdrawal_requests',
            pkColumn: 'withdrawal_id',
            pkValue: existing.withdrawal_id,
            mutationToken,
          },
        })
      : { statements: [], queuePayloads: [] };

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: `WITHDRAWAL_DECISION_${params.newStatus}`,
        resourceType: 'WITHDRAWAL',
        resourceId: existing.withdrawal_id,
        result: 'SUCCESS',
        beforeState: { status: existing.status, version: existing.version },
        afterState: {
          status: params.newStatus,
          version: params.expectedVersion + 1,
          paymentEvidenceRef: trimmedEvidence,
          decisionNote: trimmedNote,
        },
        reason: trimmedNote ?? trimmedEvidence,
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'withdrawal_requests',
        pkColumn: 'withdrawal_id',
        pkValue: existing.withdrawal_id,
        mutationToken,
      }
    );

    const results = await executeAtomicBatch(env.DB, [
      withdrawalRepository.prepareSuperAdminDecision(env.DB, {
        withdrawalId: params.withdrawalId,
        actorAdminId: params.adminId,
        newStatus: params.newStatus,
        decisionNote: trimmedNote,
        paymentEvidenceRef: trimmedEvidence,
        expectedVersion: params.expectedVersion,
        mutationToken,
        nowMs,
      }),
      auditStmt,
      ...stagedNotice.statements,
    ]);

    const updated = (results[0]?.results?.[0] as unknown as WithdrawalRequestRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(
        `Withdrawal request ${params.withdrawalId} was modified concurrently or is not in an allowed state`
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
      withdrawalId: string;
      correlationId: string;
      nowMs?: number;
    }
  ): Promise<WithdrawalRequestRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const mutationToken = generateMutationToken(nowMs);
    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.customerId,
        actorRole: 'CUSTOMER',
        action: 'WITHDRAWAL_CANCELLED_AND_PII_REDACTED',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'SUCCESS',
        afterState: { status: 'CANCELLED_BY_CUSTOMER', destinationRedacted: true },
        correlationId: params.correlationId,
        nowMs,
      },
      {
        table: 'withdrawal_requests',
        pkColumn: 'withdrawal_id',
        pkValue: params.withdrawalId,
        mutationToken,
      }
    );

    const results = await executeAtomicBatch(env.DB, [
      withdrawalRepository.prepareCustomerCancel(env.DB, {
        withdrawalId: params.withdrawalId,
        customerId: params.customerId,
        mutationToken,
        nowMs,
      }),
      auditStmt,
    ]);

    const updated = (results[0]?.results?.[0] as unknown as WithdrawalRequestRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError('Withdrawal request can only be cancelled while in SUBMITTED state');
    }
    return updated;
  },

  async formatCustomerStatus(env: Env, customerId: string): Promise<string> {
    const [customer, rows] = await Promise.all([
      customerRepository.getById(env.DB, customerId),
      withdrawalRepository.listByCustomer(env.DB, customerId, 5),
    ]);
    const lang = customer?.language_code ?? 'my';
    if (rows.length === 0) {
      return lang === 'en'
        ? '📭 You have no recent withdrawal requests.'
        : '📭 လက်ရှိတွင် ငွေထုတ်တောင်းဆိုမှု မှတ်တမ်း မရှိသေးပါ။';
    }
    const header =
      lang === 'en'
        ? '📋 <b>Your Recent Withdrawal Requests</b>\n\n'
        : '📋 <b>သင်၏ နောက်ဆုံး ငွေထုတ်တောင်းဆိုမှုများ</b>\n\n';
    return (
      header +
      rows
        .map(
          (r) =>
            `• <code>${r.withdrawal_id}</code> — <b>${r.amount.toLocaleString()} ${r.currency}</b> (${r.method_code}: <code>${r.destination_masked}</code>) — <b>${r.status}</b>`
        )
        .join('\n')
    );
  },
};
