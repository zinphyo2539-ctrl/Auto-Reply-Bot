import type { Env } from '../types/bindings';
import type { TelegramUpdate } from '../schemas/telegramSchemas';
import { selectLargestPhoto } from '../schemas/telegramSchemas';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { updateRepository } from '../repositories/updateRepository';
import { adminRepository } from '../repositories/adminRepository';
import { customerRepository } from '../repositories/customerRepository';
import { customerService } from '../services/customerService';
import { adminService } from '../services/adminService';
import { handoverService } from '../services/handoverService';
import { slipService } from '../services/slipService';
import { depositService } from '../services/depositService';
import { withdrawalService } from '../services/withdrawalService';
import { outboxService } from '../services/outboxService';
import { telegramService } from '../services/telegramService';
import { decodeCallbackData } from '../lib/callbackCodec';
import { generateMutationToken, generatePrefixedId } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { logger } from '../lib/logger';

export const updateRouter = {
  async processUpdate(
    env: Env,
    update: TelegramUpdate,
    nowMs = systemClock.now()
  ): Promise<{ status: 'PROCESSED' | 'DUPLICATE_IGNORED'; updateId: number }> {
    const workerId = generatePrefixedId('wrk', nowMs);
    const correlationId = generatePrefixedId('cor', nowMs);

    const lease = await updateRepository.acquireLease(env.DB, update.update_id, workerId, nowMs);
    if (lease.action !== 'ACQUIRED' && lease.action !== 'RECOVERED_LEASE') {
      logger.log({
        level: 'INFO',
        event: 'UPDATE_DEDUPLICATED',
        correlationId,
        updateId: update.update_id,
        metadata: { action: lease.action },
      });
      return { status: 'DUPLICATE_IGNORED', updateId: update.update_id };
    }

    try {
      await adminService.ensureBootstrapSuperAdmins(env, nowMs);

      if (update.callback_query) {
        await this.handleCallbackQuery(env, update, correlationId, nowMs);
      } else if (update.message) {
        await this.handleMessage(env, update, correlationId, nowMs);
      }

      await executeAtomicBatch(env.DB, [
        updateRepository.prepareCompleteStatement(env.DB, update.update_id, workerId, systemClock.now()),
      ]);
      return { status: 'PROCESSED', updateId: update.update_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log({
        level: 'ERROR',
        event: 'UPDATE_PROCESSING_FAILED',
        correlationId,
        updateId: update.update_id,
        message: msg,
      });
      await updateRepository.markFailed(env.DB, update.update_id, workerId, msg);
      throw err;
    }
  },

  async handleMessage(
    env: Env,
    update: TelegramUpdate,
    correlationId: string,
    nowMs: number
  ): Promise<void> {
    const msg = update.message!;
    if (!msg.from || msg.from.is_bot) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim() ?? '';
    const isAdminGroup = chatId === env.TELEGRAM_ADMIN_GROUP_ID;

    const admin = await adminRepository.getActiveAdmin(env.DB, userId);

    if (admin && (isAdminGroup || text.startsWith('/'))) {
      if (text === '/start' && msg.chat.type === 'private') {
        await adminRepository.markBotStarted(env.DB, admin.telegram_user_id, generateMutationToken(nowMs), nowMs);
        const cust = await customerService.ensureActiveCustomer(env, {
          customerId: userId,
          username: msg.from.username ?? null,
          firstName: msg.from.first_name,
          nowMs,
        });
        await customerService.sendStartMenu(env, cust, correlationId, nowMs);
        return;
      }

      if (await this.tryHandleAdminCommand(env, admin.telegram_user_id, chatId, text, correlationId, update.update_id, nowMs)) {
        return;
      }
    }

    if (isAdminGroup) {
      return;
    }

    const customer = await customerService.ensureActiveCustomer(env, {
      customerId: userId,
      username: msg.from.username ?? null,
      firstName: msg.from.first_name,
      nowMs,
    });

    if (text === '/start') {
      await customerService.sendStartMenu(env, customer, correlationId, nowMs);
      return;
    }

    if (msg.photo && msg.photo.length > 0) {
      const largest = selectLargestPhoto(msg.photo);
      await slipService.ingestCustomerSlipPhoto(env, {
        customerId: customer.telegram_user_id,
        customerFirstName: customer.first_name,
        customerUsername: customer.username,
        telegramMessageId: msg.message_id,
        updateId: update.update_id,
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
        caption: msg.caption ?? null,
        correlationId,
        nowMs,
      });
      return;
    }

    if (text) {
      await customerService.handleCustomerText(env, {
        customer,
        telegramMessageId: msg.message_id,
        updateId: update.update_id,
        text,
        correlationId,
        nowMs,
      });
    }
  },

  async tryHandleAdminCommand(
    env: Env,
    adminId: string,
    chatId: string,
    text: string,
    correlationId: string,
    updateId: number,
    nowMs: number
  ): Promise<boolean> {
    const reply = async (body: string) => {
      const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
        baseOutboxId: generatePrefixedId('obx', nowMs),
        baseIdempotencyKey: `adm_cmd:${updateId}:${adminId}`,
        eventType: 'ADMIN_CMD_REPLY',
        aggregateType: 'ADMIN',
        aggregateId: adminId,
        targetChatId: chatId,
        text: body,
        parseMode: 'HTML',
        correlationId,
        nowMs,
      });
      await executeAtomicBatch(env.DB, staged.statements);
      await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
    };

    if (text === '/admin') {
      const admin = await adminRepository.getActiveAdmin(env.DB, adminId);
      if (!admin) return false;
      const summary = await adminService.buildAdminStatusText(env, admin);
      await reply(summary);
      return true;
    }

    if (text === '/toggle_ai') {
      const res = await adminService.toggleGlobalAi(env, {
        adminId,
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      await reply(`⚙️ AI Auto-Reply is now: <b>${res.aiEnabled ? 'ENABLED 🟢' : 'DISABLED 🔴'}</b> (v${res.newVersion})`);
      return true;
    }

    if (text.startsWith('/reply ')) {
      const parts = text.split(' ');
      const ticketId = parts[1];
      const msgBody = parts.slice(2).join(' ');
      if (!ticketId || !msgBody) {
        await reply('Usage: <code>/reply &lt;TICKET_ID&gt; &lt;text&gt;</code>');
        return true;
      }
      await handoverService.sendAdminReply(env, {
        adminId,
        ticketId,
        replyText: msgBody,
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      await reply(`✅ Reply queued for Ticket <code>${ticketId}</code>.`);
      return true;
    }

    if (text.startsWith('/approve_dep ')) {
      const parts = text.split(' ');
      const depositId = parts[1];
      const ver = Number(parts[2]);
      const evidenceRef = parts.slice(3).join(' ');
      if (!depositId || Number.isNaN(ver) || !evidenceRef) {
        await reply('Usage: <code>/approve_dep &lt;DEP_ID&gt; &lt;ver&gt; &lt;EVIDENCE_REF&gt;</code>');
        return true;
      }
      const dep = await depositService.submitSuperAdminDecision(env, {
        adminId,
        depositId,
        newStatus: 'APPROVED_MANUAL_CREDITED',
        adminEvidenceRef: evidenceRef,
        expectedVersion: ver,
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      await reply(`✅ Deposit <code>${dep.deposit_id}</code> marked <b>APPROVED_MANUAL_CREDITED</b>.`);
      return true;
    }

    if (text.startsWith('/paid_wd ')) {
      const parts = text.split(' ');
      const withdrawalId = parts[1];
      const ver = Number(parts[2]);
      const evidenceRef = parts.slice(3).join(' ');
      if (!withdrawalId || Number.isNaN(ver) || !evidenceRef) {
        await reply('Usage: <code>/paid_wd &lt;WDR_ID&gt; &lt;ver&gt; &lt;PAYMENT_EVIDENCE&gt;</code>');
        return true;
      }
      const wd = await withdrawalService.submitSuperAdminDecision(env, {
        adminId,
        withdrawalId,
        newStatus: 'PAID_RECORDED',
        paymentEvidenceRef: evidenceRef,
        expectedVersion: ver,
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      await reply(`✅ Withdrawal <code>${wd.withdrawal_id}</code> marked <b>PAID_RECORDED</b>.`);
      return true;
    }

    if (text.startsWith('/view_wd_pii ')) {
      const withdrawalId = text.split(' ')[1];
      if (!withdrawalId) {
        await reply('Usage: <code>/view_wd_pii &lt;WDR_ID&gt;</code>');
        return true;
      }
      const dec = await withdrawalService.decryptDestinationForSuperAdmin(env, {
        adminId,
        withdrawalId,
        requestChatId: chatId,
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      await reply(
        `🔐 <b>Decrypted Destination (${dec.withdrawalId})</b>\n<code>${dec.plaintextDestination}</code>\n<i>Recorded in immutable audit log.</i>`
      );
      return true;
    }

    return false;
  },

  async handleCallbackQuery(
    env: Env,
    update: TelegramUpdate,
    correlationId: string,
    nowMs: number
  ): Promise<void> {
    const cb = update.callback_query!;
    const userId = String(cb.from.id);
    const chatId = String(cb.message?.chat.id ?? cb.from.id);

    try {
      const parsed = decodeCallbackData(cb.data ?? '');

      if (parsed.namespace === 'mnu') {
        const customer = await customerService.ensureActiveCustomer(env, {
          customerId: userId,
          username: cb.from.username ?? null,
          firstName: cb.from.first_name,
          nowMs,
        });

        if (parsed.action === 'lang') {
          const nextLang = parsed.targetId === 'en' ? 'en' : 'my';
          await env.DB
            .prepare(`UPDATE customers SET language_code = ?2, updated_at = ?3 WHERE telegram_user_id = ?1`)
            .bind(userId, nextLang, nowMs)
            .run();
          const refreshed = (await customerRepository.getById(env.DB, userId))!;
          await customerService.sendStartMenu(env, refreshed, correlationId, nowMs);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, nextLang === 'en' ? 'English' : 'မြန်မာဘာသာ');
          return;
        }

        if (parsed.action === 'open') {
          await this.handleCustomerMenuOpen(env, customer.telegram_user_id, customer.first_name, customer.username, parsed.targetId, correlationId, update.update_id, nowMs);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id);
          return;
        }
      }

      if (parsed.namespace === 'dep') {
        if (parsed.action === 'meth') {
          const res = await depositService.handleMethodSelection(env, userId, parsed.targetId, nowMs);
          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', nowMs),
            baseIdempotencyKey: `dep_meth:${cb.id}`,
            eventType: 'WIZARD_STEP',
            aggregateType: 'CUSTOMER',
            aggregateId: userId,
            targetChatId: chatId,
            text: res.promptText,
            parseMode: 'HTML',
            correlationId,
            nowMs,
          });
          await executeAtomicBatch(env.DB, staged.statements);
          await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id);
          return;
        }
        if (parsed.action === 'cfrm') {
          await depositService.confirmSubmission(env, {
            customerId: userId,
            draftToken: parsed.targetId,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Deposit submitted!');
          return;
        }
        if (parsed.action === 'cncl') {
          await customerRepository.clearSession(env.DB, userId);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Cancelled');
          return;
        }
      }

      if (parsed.namespace === 'wd') {
        if (parsed.action === 'meth') {
          const res = await withdrawalService.handleMethodSelection(env, userId, parsed.targetId, nowMs);
          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', nowMs),
            baseIdempotencyKey: `wd_meth:${cb.id}`,
            eventType: 'WIZARD_STEP',
            aggregateType: 'CUSTOMER',
            aggregateId: userId,
            targetChatId: chatId,
            text: res.promptText,
            parseMode: 'HTML',
            correlationId,
            nowMs,
          });
          await executeAtomicBatch(env.DB, staged.statements);
          await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id);
          return;
        }
        if (parsed.action === 'cfrm') {
          await withdrawalService.confirmSubmission(env, {
            customerId: userId,
            draftToken: parsed.targetId,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Withdrawal submitted!');
          return;
        }
        if (parsed.action === 'cncl') {
          await customerRepository.clearSession(env.DB, userId);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Cancelled');
          return;
        }
        if (parsed.action === 'pii') {
          const dec = await withdrawalService.decryptDestinationForSuperAdmin(env, {
            adminId: userId,
            withdrawalId: parsed.targetId,
            requestChatId: userId, // always deliver to private admin chat
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
            baseOutboxId: generatePrefixedId('obx', nowMs),
            baseIdempotencyKey: `wd_pii:${cb.id}`,
            eventType: 'SUPER_ADMIN_PII_DM',
            aggregateType: 'WITHDRAWAL',
            aggregateId: parsed.targetId,
            targetChatId: userId,
            text: `🔐 <b>Decrypted Destination (${dec.withdrawalId})</b>\n<code>${dec.plaintextDestination}</code>`,
            parseMode: 'HTML',
            correlationId,
            nowMs,
          });
          await executeAtomicBatch(env.DB, staged.statements);
          await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Sent to private bot chat.');
          return;
        }
      }

      if (parsed.namespace === 'tk') {
        if (parsed.action === 'claim') {
          await handoverService.takeOverTicket(env, {
            adminId: userId,
            ticketId: parsed.targetId,
            expectedVersion: parsed.version,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Ticket claimed!');
          return;
        }
        if (parsed.action === 'release') {
          await handoverService.releaseTicket(env, {
            adminId: userId,
            ticketId: parsed.targetId,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Ticket released (HUMAN kept)');
          return;
        }
        if (parsed.action === 'res_ai' || parsed.action === 'res_hum') {
          await handoverService.resolveTicket(env, {
            adminId: userId,
            ticketId: parsed.targetId,
            returnToAi: parsed.action === 'res_ai',
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Ticket resolved');
          return;
        }
      }

      if (parsed.namespace === 'sl') {
        const decisionMap: Record<string, 'APPROVED' | 'REJECTED' | 'NEEDS_INFO'> = {
          app: 'APPROVED',
          rej: 'REJECTED',
          info: 'NEEDS_INFO',
        };
        const decision = decisionMap[parsed.action];
        if (decision) {
          await slipService.submitAdminSlipDecision(env, {
            adminId: userId,
            slipId: parsed.targetId,
            decision,
            reviewNote: decision === 'APPROVED' ? null : 'Requires administrator verification',
            expectedVersion: parsed.version,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, `Slip ${decision}`);
          return;
        }
      }

      await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed';
      await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, msg, true);
    }
  },

  async handleCustomerMenuOpen(
    env: Env,
    customerId: string,
    firstName: string,
    username: string | null,
    menuCode: string,
    correlationId: string,
    updateId: number,
    nowMs: number
  ): Promise<void> {
    let text = '';
    if (menuCode === 'DEPOSIT') {
      text = (await depositService.startDepositWizard(env, customerId, nowMs)).promptText;
    } else if (menuCode === 'DEPOSIT_STATUS') {
      text = await depositService.formatCustomerStatus(env, customerId);
    } else if (menuCode === 'WITHDRAW') {
      text = (await withdrawalService.startWithdrawalWizard(env, customerId, nowMs)).promptText;
    } else if (menuCode === 'WITHDRAWAL_STATUS') {
      text = await withdrawalService.formatCustomerStatus(env, customerId);
    } else if (menuCode === 'CONTACT_SUPPORT') {
      await handoverService.escalateCustomerToHuman(env, {
        customerId,
        customerFirstName: firstName,
        customerUsername: username,
        ticketType: 'GENERAL_SUPPORT',
        summaryText: 'Customer requested human support via menu',
        reason: 'Menu CONTACT_SUPPORT',
        correlationId,
        sourceUpdateId: updateId,
        nowMs,
      });
      text = '👨‍💼 Admin ဝန်ထမ်းထံသို့ ချိတ်ဆက်ပေးထားပါသည်။ ခဏစောင့်ဆိုင်းပေးပါ။';
    } else {
      text = '🤖 သိရှိလိုသော မေးခွန်းများကို တိုက်ရိုက် ရိုက်ထည့်မေးမြန်းနိုင်ပါသည်။';
    }

    const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', nowMs),
      baseIdempotencyKey: `menu_open:${updateId}:${menuCode}`,
      eventType: 'MENU_RESPONSE',
      aggregateType: 'CUSTOMER',
      aggregateId: customerId,
      targetChatId: customerId,
      text,
      parseMode: 'HTML',
      correlationId,
      nowMs,
    });
    await executeAtomicBatch(env.DB, staged.statements);
    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
  },
};
