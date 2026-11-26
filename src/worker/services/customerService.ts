import type { Env } from '../types/bindings';
import type { CustomerRow, LanguageCode } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { customerRepository } from '../repositories/customerRepository';
import { messageRepository } from '../repositories/messageRepository';
import { configRepository } from '../repositories/configRepository';
import { geminiService } from './geminiService';
import { handoverService } from './handoverService';
import { depositService } from './depositService';
import { withdrawalService } from './withdrawalService';
import { outboxService } from './outboxService';
import { notificationService } from './notificationService';
import { encodeCallbackData } from '../lib/callbackCodec';
import { generateMutationToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';

export const customerService = {
  async ensureActiveCustomer(
    env: Env,
    params: {
      customerId: string;
      username: string | null;
      firstName: string;
      languageCode?: LanguageCode;
      nowMs?: number;
    }
  ): Promise<CustomerRow> {
    const nowMs = params.nowMs ?? systemClock.now();
    const existing = await customerRepository.getById(env.DB, params.customerId);
    const mutationToken = generateMutationToken(nowMs);

    await executeAtomicBatch(env.DB, [
      customerRepository.prepareUpsertActiveCustomer(env.DB, {
        customerId: params.customerId,
        username: params.username,
        firstName: params.firstName,
        languageCode: existing?.language_code ?? params.languageCode ?? 'my',
        mutationToken,
        nowMs,
      }),
    ]);

    const row = await customerRepository.getById(env.DB, params.customerId);
    return row!;
  },

  async sendStartMenu(
    env: Env,
    customer: CustomerRow,
    correlationId: string,
    nowMs = systemClock.now()
  ): Promise<void> {
    const config = await configRepository.getActiveConfig(env.DB);
    await customerRepository.clearSession(env.DB, customer.telegram_user_id);

    const welcomeText =
      customer.language_code === 'en' ? config.welcome_text_en : config.welcome_text_my;
    const replyMarkup = notificationService.buildCustomerMainMenuKeyboard(
      config,
      customer.language_code,
      env.OFFICIAL_CHANNEL_URL
    );

    const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `start_menu:${customer.telegram_user_id}:${correlationId}`,
      eventType: 'START_MENU',
      aggregateType: 'CUSTOMER',
      aggregateId: customer.telegram_user_id,
      targetChatId: customer.telegram_user_id,
      text: welcomeText,
      parseMode: 'HTML',
      replyMarkup,
      correlationId,
      nowMs,
    });

    await executeAtomicBatch(env.DB, staged.statements);
    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
  },

  async handleCustomerText(
    env: Env,
    params: {
      customer: CustomerRow;
      telegramMessageId: number;
      updateId: number;
      text: string;
      correlationId: string;
      nowMs?: number;
    }
  ): Promise<void> {
    const nowMs = params.nowMs ?? systemClock.now();
    const { customer, text, correlationId } = params;

    // 1. Check active Deposit/Withdrawal wizard session first
    const session = await customerRepository.getSession(env.DB, customer.telegram_user_id);
    if (session && session.expires_at > nowMs && session.wizard_type !== 'NONE') {
      if (session.wizard_type === 'DEPOSIT') {
        await this.routeDepositWizardText(env, customer, session.wizard_state, text, correlationId, nowMs);
        return;
      }
      if (session.wizard_type === 'WITHDRAWAL') {
        await this.routeWithdrawalWizardText(env, customer, session.wizard_state, text, correlationId, nowMs);
        return;
      }
    }

    // 2. Persist inbound customer text message
    const inboundMessageId = generatePrefixedId('msg', nowMs);
    await executeAtomicBatch(env.DB, [
      messageRepository.prepareInsertMessage(env.DB, {
        messageId: inboundMessageId,
        customerId: customer.telegram_user_id,
        telegramMessageId: params.telegramMessageId,
        updateId: params.updateId,
        direction: 'INBOUND',
        senderRole: 'USER',
        senderId: customer.telegram_user_id,
        messageType: 'TEXT',
        textContent: text,
        isPotentialSlip: false,
        deliveryStatus: 'RECEIVED',
        createdAt: nowMs,
      }),
    ]);

    // 3. If customer is in HUMAN mode, strictly suppress AI and forward to human admins
    if (customer.chat_mode === 'HUMAN') {
      const { ticket } = await handoverService.escalateCustomerToHuman(env, {
        customerId: customer.telegram_user_id,
        customerFirstName: customer.first_name,
        customerUsername: customer.username,
        ticketType: 'GENERAL_SUPPORT',
        summaryText: text.slice(0, 140),
        reason: 'Customer message received while in HUMAN mode',
        correlationId,
        sourceUpdateId: params.updateId,
        nowMs,
      });

      const targetChat = ticket.assigned_admin_id ?? env.TELEGRAM_ADMIN_GROUP_ID;
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `hum_fwd:${inboundMessageId}`,
        eventType: 'CUSTOMER_HUMAN_MESSAGE_FWD',
        aggregateType: 'TICKET',
        aggregateId: ticket.ticket_id,
        targetChatId: targetChat,
        text: `💬 <b>Customer (${customer.first_name} | <code>${customer.telegram_user_id}</code>)</b> [Ticket <code>${ticket.ticket_id}</code>]:\n${text}`,
        parseMode: 'HTML',
        relatedTicketId: ticket.ticket_id,
        correlationId,
        nowMs,
      });
      await executeAtomicBatch(env.DB, staged.statements);
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
      return;
    }

    // 4. AI Mode: Call Gemini with strictly isolated <=15 customer messages + approved Knowledge Base
    try {
      const aiOutput = await geminiService.generateCustomerReply({
        db: env.DB,
        apiKey: env.GEMINI_API_KEY,
        modelName: env.GEMINI_MODEL,
        officialChannelUrl: env.OFFICIAL_CHANNEL_URL,
        customerId: customer.telegram_user_id,
        incomingText: text,
      });

      if (aiOutput.requiresHumanHandover) {
        const ticketType =
          aiOutput.ticketCategory === 'SLIP_DEPOSIT' || aiOutput.ticketCategory === 'WITHDRAWAL'
            ? aiOutput.ticketCategory
            : 'GENERAL_SUPPORT';

        await handoverService.escalateCustomerToHuman(env, {
          customerId: customer.telegram_user_id,
          customerFirstName: customer.first_name,
          customerUsername: customer.username,
          ticketType,
          summaryText: text.slice(0, 140),
          reason: 'AI triggered human handover',
          correlationId,
          sourceUpdateId: params.updateId,
          nowMs,
        });

        const stagedHandoverMsg = outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `ai_handover_reply:${inboundMessageId}`,
          eventType: 'AI_HANDOVER_NOTICE',
          aggregateType: 'CUSTOMER',
          aggregateId: customer.telegram_user_id,
          targetChatId: customer.telegram_user_id,
          text: aiOutput.replyText,
          correlationId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, stagedHandoverMsg.statements);
        await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedHandoverMsg.queuePayloads);
        return;
      }

      const aiMsgId = generatePrefixedId('msg', nowMs);
      const stagedAiReply = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `ai_reply:${aiMsgId}`,
        eventType: 'AI_AUTO_REPLY',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.telegram_user_id,
        targetChatId: customer.telegram_user_id,
        text: aiOutput.replyText,
        relatedMessageId: aiMsgId,
        correlationId,
        nowMs,
      });

      // Gate AI outbound message on customer still being in AI mode
      await executeAtomicBatch(env.DB, [
        messageRepository.prepareInsertMessage(env.DB, {
          messageId: aiMsgId,
          customerId: customer.telegram_user_id,
          direction: 'OUTBOUND',
          senderRole: 'MODEL',
          senderId: 'GEMINI_AI',
          messageType: 'TEXT',
          textContent: aiOutput.replyText,
          isPotentialSlip: false,
          deliveryStatus: 'PENDING',
          createdAt: nowMs,
          gateCustomerMode: 'AI',
        }),
        ...stagedAiReply.statements,
      ]);

      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedAiReply.queuePayloads);
    } catch {
      // Fail-safe: Any Gemini error, guardrail violation (e.g. forbidden financial claim), or AI disabled escalates cleanly to HUMAN
      await handoverService.escalateCustomerToHuman(env, {
        customerId: customer.telegram_user_id,
        customerFirstName: customer.first_name,
        customerUsername: customer.username,
        ticketType: 'GENERAL_SUPPORT',
        summaryText: text.slice(0, 140),
        reason: 'AI guardrail or service fallback escalation',
        correlationId,
        sourceUpdateId: params.updateId,
        nowMs,
      });

      const fallbackText =
        customer.language_code === 'en'
          ? '👨‍💼 Connecting you to a human Support Administrator. Please wait a moment.'
          : '👨‍💼 Admin ဝန်ထမ်းထံသို့ လွှဲပြောင်းပေးထားပါသည်။ ခဏစောင့်ဆိုင်းပေးပါ။';

      const stagedFallback = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `ai_fallback:${inboundMessageId}`,
        eventType: 'AI_FALLBACK_HANDOVER',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.telegram_user_id,
        targetChatId: customer.telegram_user_id,
        text: fallbackText,
        correlationId,
        nowMs,
      });
      await executeAtomicBatch(env.DB, stagedFallback.statements);
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, stagedFallback.queuePayloads);
    }
  },

  async routeDepositWizardText(
    env: Env,
    customer: CustomerRow,
    wizardState: string,
    text: string,
    correlationId: string,
    nowMs: number
  ): Promise<void> {
    try {
      if (wizardState === 'DEP_AWAITING_AMOUNT') {
        const res = await depositService.handleAmountInput(env, customer.telegram_user_id, text, nowMs);
        const keyboard = res.methods.map((m) => [
          {
            text: customer.language_code === 'en' ? m.nameEn : m.nameMy,
            callback_data: encodeCallbackData({ namespace: 'dep', action: 'meth', targetId: m.code }),
          },
        ]);
        const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `dep_amt:${customer.telegram_user_id}:${correlationId}`,
          eventType: 'WIZARD_STEP',
          aggregateType: 'CUSTOMER',
          aggregateId: customer.telegram_user_id,
          targetChatId: customer.telegram_user_id,
          text: res.promptText,
          parseMode: 'HTML',
          replyMarkup: { inline_keyboard: keyboard },
          correlationId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, staged.statements);
        await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
        return;
      }

      if (wizardState === 'DEP_AWAITING_REFERENCE') {
        const res = await depositService.handleReferenceInput(env, customer.telegram_user_id, text, nowMs);
        const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `dep_ref:${customer.telegram_user_id}:${correlationId}`,
          eventType: 'WIZARD_STEP',
          aggregateType: 'CUSTOMER',
          aggregateId: customer.telegram_user_id,
          targetChatId: customer.telegram_user_id,
          text: res.summaryText,
          parseMode: 'HTML',
          replyMarkup: {
            inline_keyboard: [
              [
                {
                  text: customer.language_code === 'en' ? '✅ Confirm & Submit' : '✅ အတည်ပြုပေးပို့မည်',
                  callback_data: encodeCallbackData({ namespace: 'dep', action: 'cfrm', targetId: res.draftToken }),
                },
                {
                  text: customer.language_code === 'en' ? '❌ Cancel' : '❌ ပယ်ဖျက်မည်',
                  callback_data: encodeCallbackData({ namespace: 'dep', action: 'cncl', targetId: 'draft' }),
                },
              ],
            ],
          },
          correlationId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, staged.statements);
        await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Invalid input';
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `dep_err:${customer.telegram_user_id}:${correlationId}`,
        eventType: 'WIZARD_ERROR',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.telegram_user_id,
        targetChatId: customer.telegram_user_id,
        text: `⚠️ ${errMsg}`,
        correlationId,
        nowMs,
      });
      await executeAtomicBatch(env.DB, staged.statements);
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
    }
  },

  async routeWithdrawalWizardText(
    env: Env,
    customer: CustomerRow,
    wizardState: string,
    text: string,
    correlationId: string,
    nowMs: number
  ): Promise<void> {
    try {
      if (wizardState === 'WD_AWAITING_AMOUNT') {
        const res = await withdrawalService.handleAmountInput(env, customer.telegram_user_id, text, nowMs);
        const keyboard = res.methods.map((m) => [
          {
            text: customer.language_code === 'en' ? m.nameEn : m.nameMy,
            callback_data: encodeCallbackData({ namespace: 'wd', action: 'meth', targetId: m.code }),
          },
        ]);
        const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `wd_amt:${customer.telegram_user_id}:${correlationId}`,
          eventType: 'WIZARD_STEP',
          aggregateType: 'CUSTOMER',
          aggregateId: customer.telegram_user_id,
          targetChatId: customer.telegram_user_id,
          text: res.promptText,
          parseMode: 'HTML',
          replyMarkup: { inline_keyboard: keyboard },
          correlationId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, staged.statements);
        await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
        return;
      }

      if (wizardState === 'WD_AWAITING_DESTINATION') {
        const res = await withdrawalService.handleDestinationInput(env, customer.telegram_user_id, text, nowMs);
        const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
          baseOutboxId: generatePrefixedId('obx', nowMs),
          baseIdempotencyKey: `wd_dst:${customer.telegram_user_id}:${correlationId}`,
          eventType: 'WIZARD_STEP',
          aggregateType: 'CUSTOMER',
          aggregateId: customer.telegram_user_id,
          targetChatId: customer.telegram_user_id,
          text: res.summaryText,
          parseMode: 'HTML',
          replyMarkup: {
            inline_keyboard: [
              [
                {
                  text: customer.language_code === 'en' ? '✅ Confirm & Submit' : '✅ အတည်ပြုပေးပို့မည်',
                  callback_data: encodeCallbackData({ namespace: 'wd', action: 'cfrm', targetId: res.draftToken }),
                },
                {
                  text: customer.language_code === 'en' ? '❌ Cancel' : '❌ ပယ်ဖျက်မည်',
                  callback_data: encodeCallbackData({ namespace: 'wd', action: 'cncl', targetId: 'draft' }),
                },
              ],
            ],
          },
          correlationId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, staged.statements);
        await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Invalid input';
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `wd_err:${customer.telegram_user_id}:${correlationId}`,
        eventType: 'WIZARD_ERROR',
        aggregateType: 'CUSTOMER',
        aggregateId: customer.telegram_user_id,
        targetChatId: customer.telegram_user_id,
        text: `⚠️ ${errMsg}`,
        correlationId,
        nowMs,
      });
      await executeAtomicBatch(env.DB, staged.statements);
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
    }
  },
};
