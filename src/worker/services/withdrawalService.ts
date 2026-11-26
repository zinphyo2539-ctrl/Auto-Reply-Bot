import type { Env } from '../types/bindings';
import type { WithdrawalRequestRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { withdrawalRepository } from '../repositories/withdrawalRepository';
import { customerRepository } from '../repositories/customerRepository';
import { configRepository } from '../repositories/configRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { adminRepository } from '../repositories/adminRepository';
import { auditRepository } from '../repositories/auditRepository';
import { messageRepository } from '../repositories/messageRepository';
import { outboxService } from './outboxService';
import {
  ANTI_PHISHING_WARNING_EN,
  ANTI_PHISHING_WARNING_MY,
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
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }

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

    const safeCurrency = escapeHtml(config.currency);
    const promptText =
      customer.language_code === 'en'
        ? `💸 <b>Withdrawal Request</b>\nEnter withdrawal amount in ${safeCurrency} (${config.min_withdrawal_amount.toLocaleString()} - ${config.max_withdrawal_amount.toLocaleString()}):\n${ANTI_PHISHING_WARNING_EN}`
        : `💸 <b>ငွေထုတ်ရန် တောင်းဆိုမှု</b>\nထုတ်ယူလိုသော ငွေပမာဏ (${safeCurrency}) ကို ဂဏန်းဖြင့် ရိုက်ထည့်ပါ (${config.min_withdrawal_amount.toLocaleString()} - ${config.max_withdrawal_amount.toLocaleString()}):\n${ANTI_PHISHING_WARNING_MY}`;

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
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
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
    const safeCurrency = escapeHtml(config.currency);
    const promptText =
      customer.language_code === 'en'
        ? `Withdrawal Amount: <b>${amount.toLocaleString()} ${safeCurrency}</b>\nSelect your payout method:`
        : `ငွေထုတ်ပမာဏ: <b>${amount.toLocaleString()} ${safeCurrency}</b>\nငွေလက်ခံမည့် နည်းလမ်းကို ရွေးချယ်ပါ:`;

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
        ? `Method: <b>${escapeHtml(method.nameEn)}</b>\nEnter ONLY your Account Name and Account/Phone Number:\n${ANTI_PHISHING_WARNING_EN}`
        : `နည်းလမ်း: <b>${escapeHtml(method.nameMy)}</b>\nငွေလက်ခံမည့် အကောင့်အမည် နှင့် အကောင့်/ဖုန်းနံပါတ်ကိုသာ ရိုက်ထည့်ပါ:\n${ANTI_PHISHING_WARNING_MY}`;

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
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
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
      purpose: 'withdrawal_destination',
      customerId,
      recordToken: session.draft_token,
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

    const safeMasked = escapeHtml(encrypted.masked);
    const safeCurrency = escapeHtml(config.currency);
    const summaryText =
      customer.language_code === 'en'
        ? `📋 <b>Confirm Withdrawal Request</b>\nAmount: <b>${session.draft_amount?.toLocaleString()} ${safeCurrency}</b>\nMethod: <b>${escapeHtml(session.draft_method_code ?? '')}</b>\nDestination: <code>${safeMasked}</code>`
        : `📋 <b>ငွေထုတ်တောင်းဆိုမှု အတည်ပြုရန်</b>\nပမာဏ: <b>${session.draft_amount?.toLocaleString()} ${safeCurrency}</b>\nနည်းလမ်း: <b>${escapeHtml(session.draft_method_code ?? '')}</b>\nလက်ခံမည့်အကောင့်: <code>${safeMasked}</code>`;

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
      if (existingByToken.customer_id !== params.customerId) {
        throw new AuthorizationError('Withdrawal draft token does not belong to this customer');
      }
      return { withdrawal: existingByToken, createdNew: false };
    }

    const [customer, config, activeTicket] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      configRepository.getActiveConfig(env.DB),
      ticketRepository.findActiveByCustomer(env.DB, params.customerId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }

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
        if (retryLookup.customer_id !== params.customerId) {
          throw new AuthorizationError('Withdrawal draft token does not belong to this customer');
        }
        return { withdrawal: retryLookup, createdNew: false };
      }
      throw new ConflictError('Withdrawal submission failed validation or session expired');
    }

    await customerRepository.clearSession(env.DB, params.customerId);

    const ticketRow = (await ticketRepository.getById(env.DB, createdWd.ticket_id))!;
    const ackText =
      customer.language_code === 'en'
        ? `${STANDARD_REQUEST_ACK_EN}\n\nRef: <code>${escapeHtml(createdWd.withdrawal_id)}</code>\nAmount: <b>${createdWd.amount.toLocaleString()} ${escapeHtml(createdWd.currency)}</b> (${escapeHtml(createdWd.method_code)})\nDestination: <code>${escapeHtml(createdWd.destination_masked)}</code>`
        : `${STANDARD_REQUEST_ACK_MY}\n\nအမှတ်စဉ်: <code>${escapeHtml(createdWd.withdrawal_id)}</code>\nပမာဏ: <b>${createdWd.amount.toLocaleString()} ${escapeHtml(createdWd.currency)}</b> (${escapeHtml(createdWd.method_code)})\nလက်ခံမည့်အကောင့်: <code>${escapeHtml(createdWd.destination_masked)}</code>`;

    const cancelReplyMarkup = {
      inline_keyboard: [
        [
          {
            text: customer.language_code === 'en' ? '❌ Cancel Request' : '❌ တောင်းဆိုမှု ပယ်ဖျက်မည်',
            callback_data: encodeCallbackData({
              namespace: 'wd',
              action: 'creq',
              targetId: createdWd.withdrawal_id,
              version: createdWd.version,
            }),
          },
        ],
      ],
    };

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
      replyMarkup: cancelReplyMarkup,
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

    await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [auditStmt, ...stagedCust.statements, ...stagedGroup.statements],
      {
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
      }
    );

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, [
      ...stagedCust.queuePayloads,
      ...stagedGroup.queuePayloads,
    ]);

    return { withdrawal: createdWd, createdNew: true };
  },

  /**
   * Fail-closed Audit-Before-Decrypt in private SUPER_ADMIN chat ONLY.
   * Enforces SUPER_ADMIN RBAC and has_started_bot BEFORE resource lookup.
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

    if (admin.has_started_bot !== 1) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: 'UNSTARTED_ADMIN_WITHDRAWAL_PII_DECRYPT_BLOCKED',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        reason: 'SUPER_ADMIN must run /start in private bot chat before decrypting payout destination',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      const botHandle = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
      const botHint = botHandle ? `@${botHandle}` : 'the bot';
      throw new AuthorizationError(
        `Please open private chat with ${botHint} and send /start before decrypting payout destinations.`
      );
    }

    if (
      params.requestChatId === env.TELEGRAM_ADMIN_GROUP_ID ||
      params.requestChatId.startsWith('-') ||
      params.requestChatId !== params.adminId
    ) {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: 'GROUP_CHAT_WITHDRAWAL_PII_DECRYPT_BLOCKED',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        reason: 'Payout destination decryption is strictly forbidden outside the SUPER_ADMIN private chat',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Payout destination cannot be decrypted inside a group chat. Use private bot chat.');
    }

    const withdrawal = await withdrawalRepository.getById(env.DB, params.withdrawalId);
    if (!withdrawal) {
      throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
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
        purpose: 'withdrawal_destination',
        customerId: withdrawal.customer_id,
        recordToken: withdrawal.idempotency_token,
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

    // Enforce SUPER_ADMIN RBAC BEFORE resource lookup to prevent resource enumeration
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_WITHDRAWAL_DECISION_ATTEMPT',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'DENIED',
        afterState: { attemptedStatus: params.newStatus },
        reason: 'Only SUPER_ADMIN may decide withdrawal requests',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial withdrawal decisions');
    }

    const existing = await withdrawalRepository.getById(env.DB, params.withdrawalId);
    if (!existing) {
      throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
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
      params.newStatus === 'APPROVED_FOR_PAYOUT' ||
      params.newStatus === 'PAID_RECORDED' ||
      params.newStatus === 'REJECTED' ||
      params.newStatus === 'NEEDS_INFO';

    let notifyText = '';
    let replyMarkup: Record<string, unknown> | undefined;
    if (params.newStatus === 'APPROVED_FOR_PAYOUT') {
      notifyText =
        lang === 'en'
          ? `🟡 <b>Withdrawal Approved for Manual Payout Processing</b>\nYour withdrawal request has been reviewed and approved for external manual payout. Payment has NOT been completed yet—you will receive a separate confirmation once an Administrator records payout completion.\nRef: <code>${escapeHtml(existing.withdrawal_id)}</code>\nAmount: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>`
          : `🟡 <b>ငွေထုတ်တောင်းဆိုမှုကို လွှဲပေးရန် အတည်ပြုပြီး (လုပ်ဆောင်ဆဲ)</b>\nသင်၏ ငွေထုတ်တောင်းဆိုမှုကို Admin မှ စစ်ဆေးအတည်ပြုပြီး ပြင်ပငွေလွှဲလုပ်ငန်းစဉ် ဆောင်ရွက်နေပါသည်။ ငွေလွှဲပြီးစီးကြောင်း အတည်ပြုချက် သီးခြားထပ်မံပေးပို့ပါမည်။\nအမှတ်စဉ်: <code>${escapeHtml(existing.withdrawal_id)}</code>\nပမာဏ: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>`;
    } else if (params.newStatus === 'PAID_RECORDED') {
      const safeEvidence = escapeHtml(trimmedEvidence ?? '');
      notifyText =
        lang === 'en'
          ? `✅ <b>Withdrawal Payout Recorded by Admin (Manual Process)</b>\nAn authorized Administrator has recorded external manual payout completion for your withdrawal request.\nRef: <code>${escapeHtml(existing.withdrawal_id)}</code>\nAmount: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>\nPayment Evidence Ref: <code>${safeEvidence}</code>`
          : `✅ <b>ငွေထုတ်ပေးချေမှုကို Admin မှ ကိုယ်တိုင်လွှဲပေးပြီး မှတ်တမ်းတင်ပြီးပါပြီ</b>\nတာဝန်ရှိ Admin မှ ပြင်ပငွေလွှဲစနစ်ဖြင့် ငွေလွှဲပေးပြီးကြောင်း မှတ်တမ်းတင်ပြီးပါပြီ။\nအမှတ်စဉ်: <code>${escapeHtml(existing.withdrawal_id)}</code>\nပမာဏ: <b>${existing.amount.toLocaleString()} ${escapeHtml(existing.currency)}</b>\nငွေလွှဲအထောက်အထား: <code>${safeEvidence}</code>`;
    } else if (params.newStatus === 'REJECTED') {
      const safeNote = escapeHtml(trimmedNote ?? '');
      notifyText =
        lang === 'en'
          ? `❌ <b>Withdrawal Request Rejected</b>\nRef: <code>${escapeHtml(existing.withdrawal_id)}</code>\nReason: ${safeNote}`
          : `❌ <b>ငွေထုတ်တောင်းဆိုမှု ပယ်ချခံရပါသည်</b>\nအမှတ်စဉ်: <code>${escapeHtml(existing.withdrawal_id)}</code>\nအကြောင်းပြချက်: ${safeNote}`;
    } else if (params.newStatus === 'NEEDS_INFO') {
      const safeNote = escapeHtml(trimmedNote ?? '');
      notifyText =
        lang === 'en'
          ? `❓ <b>Additional Information Needed (Withdrawal)</b>\nRef: <code>${escapeHtml(existing.withdrawal_id)}</code>\nNote: ${safeNote}`
          : `❓ <b>ငွေထုတ်မှုအတွက် အချက်အလက်ထပ်မံလိုအပ်ပါသည်</b>\nအမှတ်စဉ်: <code>${escapeHtml(existing.withdrawal_id)}</code>\nမှတ်ချက်: ${safeNote}`;
      replyMarkup = {
        inline_keyboard: [
          [
            {
              text: lang === 'en' ? '📝 Reply with Additional Info' : '📝 အချက်အလက် ပြန်လည်ပေးပို့မည်',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'rinfo',
                targetId: existing.withdrawal_id,
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
          baseIdempotencyKey: `wd_dec_cust:${existing.withdrawal_id}:v${params.expectedVersion + 1}`,
          eventType: `WITHDRAWAL_${params.newStatus}`,
          aggregateType: 'WITHDRAWAL',
          aggregateId: existing.withdrawal_id,
          targetChatId: existing.customer_id,
          text: notifyText,
          parseMode: 'HTML',
          replyMarkup,
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

    const results = await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [
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
      ],
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

    const updated = (results[0]?.results?.[0] as unknown as WithdrawalRequestRow | undefined) ?? null;
    if (!updated) {
      throw new ConflictError(
        `Withdrawal request ${params.withdrawalId} was modified concurrently or is not in an allowed state for ${params.newStatus}`
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
      expectedVersion?: number;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<WithdrawalRequestRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const customer = await customerRepository.getById(env.DB, params.customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }

    const existing = await withdrawalRepository.getById(env.DB, params.withdrawalId);
    if (!existing) {
      throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
    }
    if (existing.customer_id !== params.customerId) {
      throw new AuthorizationError('Only the owning customer may cancel this withdrawal request');
    }
    if (existing.status === 'CANCELLED_BY_CUSTOMER') {
      return existing;
    }

    const mutationToken = generateMutationToken(nowMs);
    const confirmText =
      customer.language_code === 'en'
        ? `❌ Withdrawal request <code>${escapeHtml(existing.withdrawal_id)}</code> has been cancelled and your encrypted payout destination has been redacted.`
        : `❌ ငွေထုတ်တောင်းဆိုမှု <code>${escapeHtml(existing.withdrawal_id)}</code> ကို ပယ်ဖျက်ပြီး ငွေလက်ခံအကောင့်အချက်အလက်ကို ဖျက်သိမ်းပြီးပါပြီ။`;

    const stagedConfirm = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `wd_cncl_cust:${existing.withdrawal_id}`,
      eventType: 'WITHDRAWAL_CANCELLED_BY_CUSTOMER',
      aggregateType: 'WITHDRAWAL',
      aggregateId: existing.withdrawal_id,
      targetChatId: params.customerId,
      text: confirmText,
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
    });

    const results = await auditRepository.executeBatchWithAudit(
      env.DB,
      (auditStmt) => [
        withdrawalRepository.prepareCustomerCancel(env.DB, {
          withdrawalId: params.withdrawalId,
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
        action: 'WITHDRAWAL_CANCELLED_AND_PII_REDACTED',
        resourceType: 'WITHDRAWAL',
        resourceId: params.withdrawalId,
        result: 'SUCCESS',
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'CANCELLED_BY_CUSTOMER', destinationRedacted: true },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'withdrawal_requests',
        pkColumn: 'withdrawal_id',
        pkValue: params.withdrawalId,
        mutationToken,
      }
    );

    const updated = (results[0]?.results?.[0] as unknown as WithdrawalRequestRow | undefined) ?? null;
    if (!updated) {
      const latest = await withdrawalRepository.getById(env.DB, params.withdrawalId);
      if (latest && latest.customer_id === params.customerId && latest.status === 'CANCELLED_BY_CUSTOMER') {
        return latest;
      }
      throw new ConflictError('Withdrawal request can only be cancelled while in SUBMITTED state');
    }

    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedConfirm.queuePayloads);
    return updated;
  },

  async startNeedsInfoReplySession(
    env: Env,
    params: {
      customerId: string;
      withdrawalId: string;
      expectedVersion?: number;
      nowMs?: number;
    }
  ): Promise<{ promptText: string }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const [customer, existing] = await Promise.all([
      customerRepository.getById(env.DB, params.customerId),
      withdrawalRepository.getById(env.DB, params.withdrawalId),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.account_status === 'BANNED') {
      throw new AuthorizationError('Customer account is suspended');
    }
    if (!existing) throw new NotFoundError(`Withdrawal request ${params.withdrawalId} not found`);
    if (existing.customer_id !== params.customerId) {
      throw new AuthorizationError('Withdrawal request does not belong to this customer');
    }
    if (existing.status !== 'NEEDS_INFO') {
      throw new ConflictError('Withdrawal request is not currently awaiting additional information');
    }
    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new ConflictError('Withdrawal request status has changed; please refresh');
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
      target_request_type: 'WITHDRAWAL',
      target_request_id: existing.withdrawal_id,
      started_at: nowMs,
      expires_at: nowMs + WIZARD_TTL_MS,
      updated_at: nowMs,
    });

    const promptText =
      customer.language_code === 'en'
        ? `📝 Please send the requested additional information for Withdrawal <code>${escapeHtml(existing.withdrawal_id)}</code>:\n${ANTI_PHISHING_WARNING_EN}`
        : `📝 ငွေထုတ်တောင်းဆိုမှု <code>${escapeHtml(existing.withdrawal_id)}</code> အတွက် Admin မှ တောင်းဆိုထားသော အချက်အလက်ကို ပေးပို့ပေးပါ:\n${ANTI_PHISHING_WARNING_MY}`;

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
  ): Promise<{ withdrawalId: string }> {
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
      session.target_request_type !== 'WITHDRAWAL' ||
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

    const existing = await withdrawalRepository.getById(env.DB, session.target_request_id);
    if (!existing || existing.customer_id !== params.customerId) {
      await customerRepository.clearSession(env.DB, params.customerId);
      throw new NotFoundError('Referenced withdrawal request was not found');
    }
    if (existing.status !== 'NEEDS_INFO') {
      await customerRepository.clearSession(env.DB, params.customerId);
      throw new ConflictError('Withdrawal request is no longer in NEEDS_INFO state');
    }

    const ticket = await ticketRepository.getById(env.DB, existing.ticket_id);
    const targetAdminChat = ticket?.assigned_admin_id ?? env.TELEGRAM_ADMIN_GROUP_ID;
    const messageId = generatePrefixedId('msg', nowMs);

    const stagedCustAck = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `wd_ninfo_ack:${existing.withdrawal_id}:${params.updateId}`,
      eventType: 'WITHDRAWAL_NEEDS_INFO_REPLIED_ACK',
      aggregateType: 'WITHDRAWAL',
      aggregateId: existing.withdrawal_id,
      targetChatId: params.customerId,
      text:
        customer.language_code === 'en'
          ? `✅ Your additional information for Withdrawal <code>${escapeHtml(existing.withdrawal_id)}</code> has been forwarded to the Admin team for review.`
          : `✅ ငွေထုတ်တောင်းဆိုမှု <code>${escapeHtml(existing.withdrawal_id)}</code> အတွက် သင်ပေးပို့သော အချက်အလက်ကို Admin ထံ ပို့ဆောင်ပြီးပါပြီ။`,
      parseMode: 'HTML',
      relatedTicketId: existing.ticket_id,
      correlationId: params.correlationId,
      nowMs,
    });

    const stagedAdminAlert = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `wd_ninfo_adm:${existing.withdrawal_id}:${params.updateId}`,
      eventType: 'WITHDRAWAL_NEEDS_INFO_CUSTOMER_REPLY',
      aggregateType: 'WITHDRAWAL',
      aggregateId: existing.withdrawal_id,
      targetChatId: targetAdminChat,
      text: `📩 <b>Customer Info Reply (Withdrawal <code>${escapeHtml(existing.withdrawal_id)}</code>)</b>\n• Customer: ${escapeHtml(customer.first_name)} (<code>${escapeHtml(customer.telegram_user_id)}</code>)\n• Masked Dest: <code>${escapeHtml(existing.destination_masked)}</code>\n• Reply: ${escapeHtml(trimmed)}`,
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: '🔍 Reopen Review',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'rev',
                targetId: existing.withdrawal_id,
                version: existing.version,
              }),
            },
          ],
        ],
      },
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
        action: 'WITHDRAWAL_NEEDS_INFO_CUSTOMER_REPLIED',
        resourceType: 'WITHDRAWAL',
        resourceId: existing.withdrawal_id,
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

    return { withdrawalId: existing.withdrawal_id };
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
            `• <code>${escapeHtml(r.withdrawal_id)}</code> — <b>${r.amount.toLocaleString()} ${escapeHtml(r.currency)}</b> (${escapeHtml(r.method_code)}: <code>${escapeHtml(r.destination_masked)}</code>) — <b>${escapeHtml(r.status)}</b>`
        )
        .join('\n')
    );
  },
};
