import type { Env } from '../types/bindings';
import type { TelegramUpdate } from '../schemas/telegramSchemas';
import { selectLargestPhoto } from '../schemas/telegramSchemas';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { updateRepository } from '../repositories/updateRepository';
import { adminRepository } from '../repositories/adminRepository';
import { customerRepository } from '../repositories/customerRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { depositRepository } from '../repositories/depositRepository';
import { withdrawalRepository } from '../repositories/withdrawalRepository';
import { auditRepository } from '../repositories/auditRepository';
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
import { escapeHtml } from '../lib/textChunker';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../lib/errors';
import { logger } from '../lib/logger';

function isExpectedDomainError(err: unknown): err is Error {
  return (
    err instanceof AuthorizationError ||
    err instanceof ValidationError ||
    err instanceof ConflictError ||
    err instanceof NotFoundError
  );
}

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

  async sendSimpleOutboxReply(
    env: Env,
    params: {
      idempotencyKey: string;
      eventType: string;
      aggregateType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM' | 'TICKET' | 'DEPOSIT' | 'WITHDRAWAL';
      aggregateId: string;
      targetChatId: string;
      text: string;
      parseMode?: 'HTML';
      correlationId: string;
      nowMs: number;
    }
  ): Promise<void> {
    const staged = outboxService.prepareChunkedTextOutbox(env.DB, {
      baseOutboxId: generatePrefixedId('obx', params.nowMs),
      baseIdempotencyKey: params.idempotencyKey,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      targetChatId: params.targetChatId,
      text: params.text,
      parseMode: params.parseMode ?? 'HTML',
      correlationId: params.correlationId,
      nowMs: params.nowMs,
    });
    await executeAtomicBatch(env.DB, staged.statements);
    await outboxService.dispatchQueueSignalsBestEffort(env.OUTBOX_QUEUE, staged.queuePayloads);
  },

  async handleMessage(
    env: Env,
    update: TelegramUpdate,
    correlationId: string,
    nowMs: number
  ): Promise<void> {
    const msg = update.message!;
    const chatId = String(msg.chat.id);

    // F-10: Detect Telegram group -> supergroup migration before normal message routing
    if (typeof msg.migrate_to_chat_id === 'number') {
      const newChatId = String(msg.migrate_to_chat_id);
      logger.log({
        level: 'WARN',
        event: 'TELEGRAM_GROUP_MIGRATED_TO_SUPERGROUP',
        correlationId,
        updateId: update.update_id,
        metadata: { oldChatId: chatId, newChatId },
      });

      await auditRepository.appendImmediate(env.DB, {
        actorId: 'TELEGRAM_SYSTEM',
        actorRole: 'SYSTEM',
        action: 'TELEGRAM_GROUP_MIGRATED_TO_SUPERGROUP',
        resourceType: 'SYSTEM',
        resourceId: chatId,
        result: 'SUCCESS',
        beforeState: { chatId },
        afterState: { migrateToChatId: newChatId },
        correlationId,
        sourceUpdateId: update.update_id,
        nowMs,
      });

      if (chatId === env.TELEGRAM_ADMIN_GROUP_ID) {
        const superAdmins = await adminRepository.listActiveSuperAdmins(env.DB);
        for (const sa of superAdmins) {
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `grp_migrated:${chatId}:${newChatId}:${sa.telegram_user_id}`,
            eventType: 'ADMIN_GROUP_MIGRATION_ALERT',
            aggregateType: 'SYSTEM',
            aggregateId: chatId,
            targetChatId: sa.telegram_user_id,
            text: `⚠️ <b>Admin Group Migrated to Supergroup</b>\nOld Chat ID: <code>${escapeHtml(chatId)}</code>\nNew Supergroup ID: <code>${escapeHtml(newChatId)}</code>\nPlease update <code>TELEGRAM_ADMIN_GROUP_ID</code> in Cloudflare Worker configuration immediately.`,
            correlationId,
            nowMs,
          });
        }
      }
      return;
    }

    if (!msg.from || msg.from.is_bot) return;

    const userId = String(msg.from.id);
    const text = msg.text?.trim() ?? '';
    const isAdminGroup = chatId === env.TELEGRAM_ADMIN_GROUP_ID;

    const admin = await adminRepository.getActiveAdmin(env.DB, userId);

    // F-01: Match /start and /start <payload> in private chat to mark admin has_started_bot = 1
    if (admin && msg.chat.type === 'private' && (text === '/start' || text.startsWith('/start '))) {
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

    // Active admin command handling (group or private chat)
    if (admin && (isAdminGroup || text.startsWith('/'))) {
      if (await this.tryHandleAdminCommand(env, admin.telegram_user_id, chatId, text, correlationId, update.update_id, nowMs)) {
        return;
      }
    }

    // F-03: Active private admin session text input (reply, evidence ref, rejection/needs_info note)
    if (admin && msg.chat.type === 'private' && text && !text.startsWith('/')) {
      const handledSession = await this.tryHandleAdminPrivateSessionInput(
        env,
        admin.telegram_user_id,
        chatId,
        text,
        correlationId,
        update.update_id,
        nowMs
      );
      if (handledSession) {
        return;
      }
    }

    if (isAdminGroup) {
      return;
    }

    // F-08: Immediate BANNED customer gate before any menu, wizard, Gemini, or ticket work
    const preExistingCustomer = await customerRepository.getById(env.DB, userId);
    if (preExistingCustomer?.account_status === 'BANNED') {
      return;
    }

    const customer = await customerService.ensureActiveCustomer(env, {
      customerId: userId,
      username: msg.from.username ?? null,
      firstName: msg.from.first_name,
      nowMs,
    });

    if (customer.account_status === 'BANNED') {
      return;
    }

    if (text === '/start' || text.startsWith('/start ')) {
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

  async tryHandleAdminPrivateSessionInput(
    env: Env,
    adminId: string,
    chatId: string,
    text: string,
    correlationId: string,
    updateId: number,
    nowMs: number
  ): Promise<boolean> {
    const session = await adminRepository.getSession(env.DB, adminId);
    if (!session || session.session_state === 'IDLE') {
      return false;
    }
    if (session.expires_at <= nowMs) {
      await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
      return false;
    }

    const reply = async (body: string) => {
      await this.sendSimpleOutboxReply(env, {
        idempotencyKey: `adm_sess:${updateId}:${adminId}`,
        eventType: 'ADMIN_SESSION_REPLY',
        aggregateType: 'ADMIN',
        aggregateId: adminId,
        targetChatId: chatId,
        text: body,
        correlationId,
        nowMs,
      });
    };

    try {
      if (session.session_state === 'REPLYING_TO_CUSTOMER') {
        if (!session.target_ticket_id) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          return false;
        }
        await handoverService.sendAdminReply(env, {
          adminId,
          ticketId: session.target_ticket_id,
          replyText: text,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await reply(`✅ Reply queued for Ticket <code>${escapeHtml(session.target_ticket_id)}</code>.`);
        return true;
      }

      if (session.session_state === 'AWAITING_DEPOSIT_EVIDENCE') {
        if (!session.target_deposit_id || session.target_expected_version === null) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          throw new ConflictError('Deposit evidence session is incomplete');
        }
        const dep = await depositService.submitSuperAdminDecision(env, {
          adminId,
          depositId: session.target_deposit_id,
          newStatus: 'APPROVED_MANUAL_CREDITED',
          adminEvidenceRef: text,
          expectedVersion: session.target_expected_version,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply(
          `✅ Deposit <code>${escapeHtml(dep.deposit_id)}</code> recorded as <b>APPROVED_MANUAL_CREDITED</b> (manual Admin verification).`
        );
        return true;
      }

      if (session.session_state === 'AWAITING_DEPOSIT_NOTE') {
        const decision = session.pending_decision;
        if (
          !session.target_deposit_id ||
          session.target_expected_version === null ||
          (decision !== 'REJECTED' && decision !== 'NEEDS_INFO')
        ) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          throw new ConflictError('Deposit decision session is incomplete');
        }
        const dep = await depositService.submitSuperAdminDecision(env, {
          adminId,
          depositId: session.target_deposit_id,
          newStatus: decision,
          decisionNote: text,
          expectedVersion: session.target_expected_version,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply(`✅ Deposit <code>${escapeHtml(dep.deposit_id)}</code> marked <b>${escapeHtml(dep.status)}</b>.`);
        return true;
      }

      if (session.session_state === 'AWAITING_WITHDRAWAL_EVIDENCE') {
        if (!session.target_withdrawal_id || session.target_expected_version === null) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          throw new ConflictError('Withdrawal evidence session is incomplete');
        }
        const wd = await withdrawalService.submitSuperAdminDecision(env, {
          adminId,
          withdrawalId: session.target_withdrawal_id,
          newStatus: 'PAID_RECORDED',
          paymentEvidenceRef: text,
          expectedVersion: session.target_expected_version,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply(
          `✅ Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> recorded as <b>PAID_RECORDED</b> (external manual payout).`
        );
        return true;
      }

      if (session.session_state === 'AWAITING_WITHDRAWAL_NOTE') {
        const decision = session.pending_decision;
        if (
          !session.target_withdrawal_id ||
          session.target_expected_version === null ||
          (decision !== 'REJECTED' && decision !== 'NEEDS_INFO')
        ) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          throw new ConflictError('Withdrawal decision session is incomplete');
        }
        const wd = await withdrawalService.submitSuperAdminDecision(env, {
          adminId,
          withdrawalId: session.target_withdrawal_id,
          newStatus: decision,
          decisionNote: text,
          expectedVersion: session.target_expected_version,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply(`✅ Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> marked <b>${escapeHtml(wd.status)}</b>.`);
        return true;
      }

      if (session.session_state === 'AWAITING_SLIP_NOTE') {
        const decision = session.pending_decision;
        if (
          !session.target_slip_id ||
          (decision !== 'REJECTED' && decision !== 'NEEDS_INFO')
        ) {
          await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
          throw new ConflictError('Slip note session is incomplete');
        }
        const slip = await slipService.submitAdminSlipDecision(env, {
          adminId,
          slipId: session.target_slip_id,
          decision,
          reviewNote: text,
          expectedVersion: session.target_expected_version ?? undefined,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply(`✅ Slip <code>${escapeHtml(slip.slip_id)}</code> marked <b>${escapeHtml(slip.review_status)}</b>.`);
        return true;
      }

      return false;
    } catch (err) {
      if (isExpectedDomainError(err)) {
        await reply(`⚠️ ${escapeHtml(err.message)}`);
        return true;
      }
      throw err;
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
      await this.sendSimpleOutboxReply(env, {
        idempotencyKey: `adm_cmd:${updateId}:${adminId}`,
        eventType: 'ADMIN_CMD_REPLY',
        aggregateType: 'ADMIN',
        aggregateId: adminId,
        targetChatId: chatId,
        text: body,
        correlationId,
        nowMs,
      });
    };

    // F-02: Catch expected domain/auth/validation/conflict/not-found errors so Telegram receives HTTP 200 (no poison retry loop)
    try {
      if (text === '/cancel') {
        await executeAtomicBatch(env.DB, [adminRepository.prepareClearSession(env.DB, adminId)]);
        await reply('✅ Active admin input session cleared.');
        return true;
      }

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
        await reply(`✅ Reply queued for Ticket <code>${escapeHtml(ticketId)}</code>.`);
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
        await reply(
          `✅ Deposit <code>${escapeHtml(dep.deposit_id)}</code> recorded as <b>APPROVED_MANUAL_CREDITED</b> (manual Admin verification).`
        );
        return true;
      }

      if (text.startsWith('/reject_dep ')) {
        const parts = text.split(' ');
        const depositId = parts[1];
        const ver = Number(parts[2]);
        const reason = parts.slice(3).join(' ');
        if (!depositId || Number.isNaN(ver) || !reason) {
          await reply('Usage: <code>/reject_dep &lt;DEP_ID&gt; &lt;ver&gt; &lt;REASON&gt;</code>');
          return true;
        }
        const dep = await depositService.submitSuperAdminDecision(env, {
          adminId,
          depositId,
          newStatus: 'REJECTED',
          decisionNote: reason,
          expectedVersion: ver,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await reply(`❌ Deposit <code>${escapeHtml(dep.deposit_id)}</code> marked <b>REJECTED</b>.`);
        return true;
      }

      if (text.startsWith('/review_wd ')) {
        const parts = text.split(' ');
        const withdrawalId = parts[1];
        const ver = Number(parts[2]);
        if (!withdrawalId || Number.isNaN(ver)) {
          await reply('Usage: <code>/review_wd &lt;WDR_ID&gt; &lt;ver&gt;</code>');
          return true;
        }
        const wd = await withdrawalService.submitSuperAdminDecision(env, {
          adminId,
          withdrawalId,
          newStatus: 'UNDER_REVIEW',
          expectedVersion: ver,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await reply(`🔍 Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> moved to <b>UNDER_REVIEW</b> (v${wd.version}).`);
        return true;
      }

      if (text.startsWith('/approve_wd ')) {
        const parts = text.split(' ');
        const withdrawalId = parts[1];
        const ver = Number(parts[2]);
        if (!withdrawalId || Number.isNaN(ver)) {
          await reply('Usage: <code>/approve_wd &lt;WDR_ID&gt; &lt;ver&gt;</code>');
          return true;
        }
        const wd = await withdrawalService.submitSuperAdminDecision(env, {
          adminId,
          withdrawalId,
          newStatus: 'APPROVED_FOR_PAYOUT',
          expectedVersion: ver,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await reply(
          `🟡 Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> marked <b>APPROVED_FOR_PAYOUT</b> (v${wd.version}). Record external payout completion separately with <code>/paid_wd</code>.`
        );
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
        await reply(
          `✅ Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> recorded as <b>PAID_RECORDED</b> (external manual payout).`
        );
        return true;
      }

      if (text.startsWith('/reject_wd ')) {
        const parts = text.split(' ');
        const withdrawalId = parts[1];
        const ver = Number(parts[2]);
        const reason = parts.slice(3).join(' ');
        if (!withdrawalId || Number.isNaN(ver) || !reason) {
          await reply('Usage: <code>/reject_wd &lt;WDR_ID&gt; &lt;ver&gt; &lt;REASON&gt;</code>');
          return true;
        }
        const wd = await withdrawalService.submitSuperAdminDecision(env, {
          adminId,
          withdrawalId,
          newStatus: 'REJECTED',
          decisionNote: reason,
          expectedVersion: ver,
          correlationId,
          sourceUpdateId: updateId,
          nowMs,
        });
        await reply(`❌ Withdrawal <code>${escapeHtml(wd.withdrawal_id)}</code> marked <b>REJECTED</b>.`);
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
          `🔐 <b>Decrypted Destination (${escapeHtml(dec.withdrawalId)})</b>\n<code>${escapeHtml(dec.plaintextDestination)}</code>\n<i>Recorded in immutable audit log.</i>`
        );
        return true;
      }

      return false;
    } catch (err) {
      if (isExpectedDomainError(err)) {
        await reply(`⚠️ ${escapeHtml(err.message)}`);
        return true;
      }
      throw err;
    }
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

      // F-08: Block BANNED customers on all customer-facing callback namespaces/actions
      const isCustomerCallback =
        parsed.namespace === 'mnu' ||
        (parsed.namespace === 'dep' && ['meth', 'cfrm', 'cncl', 'creq', 'rinfo'].includes(parsed.action)) ||
        (parsed.namespace === 'wd' && ['meth', 'cfrm', 'cncl', 'creq', 'rinfo'].includes(parsed.action));

      if (isCustomerCallback) {
        const existingCustomer = await customerRepository.getById(env.DB, userId);
        if (existingCustomer?.account_status === 'BANNED') {
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Account suspended.', true);
          return;
        }
      }

      if (parsed.namespace === 'mnu') {
        const customer = await customerService.ensureActiveCustomer(env, {
          customerId: userId,
          username: cb.from.username ?? null,
          firstName: cb.from.first_name,
          nowMs,
        });
        if (customer.account_status === 'BANNED') {
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Account suspended.', true);
          return;
        }

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
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `dep_meth:${cb.id}`,
            eventType: 'WIZARD_STEP',
            aggregateType: 'CUSTOMER',
            aggregateId: userId,
            targetChatId: chatId,
            text: res.promptText,
            correlationId,
            nowMs,
          });
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
        if (parsed.action === 'creq') {
          await depositService.cancelByCustomer(env, {
            customerId: userId,
            depositId: parsed.targetId,
            expectedVersion: parsed.version,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Deposit cancelled.');
          return;
        }
        if (parsed.action === 'rinfo') {
          const res = await depositService.startNeedsInfoReplySession(env, {
            customerId: userId,
            depositId: parsed.targetId,
            expectedVersion: parsed.version,
            nowMs,
          });
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `dep_rinfo:${cb.id}`,
            eventType: 'NEEDS_INFO_PROMPT',
            aggregateType: 'DEPOSIT',
            aggregateId: parsed.targetId,
            targetChatId: userId,
            text: res.promptText,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Send your reply now.');
          return;
        }
        if (parsed.action === 'app' || parsed.action === 'rej' || parsed.action === 'info') {
          const adminRow = await adminRepository.getActiveAdmin(env.DB, userId);
          if (!adminRow || adminRow.role !== 'SUPER_ADMIN') {
            await auditRepository.appendImmediate(env.DB, {
              actorId: userId,
              actorRole: adminRow?.role ?? 'UNAUTHORIZED',
              action: 'UNAUTHORIZED_DEPOSIT_CALLBACK_ATTEMPT',
              resourceType: 'DEPOSIT',
              resourceId: parsed.targetId,
              result: 'DENIED',
              afterState: { action: parsed.action },
              reason: 'Only SUPER_ADMIN may initiate deposit decision callbacks',
              correlationId,
              sourceUpdateId: update.update_id,
              nowMs,
            });
            throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial deposit decisions');
          }
          if (adminRow.has_started_bot !== 1) {
            throw new AuthorizationError('Please send /start to the bot in private chat first.');
          }
          const existingDep = await depositRepository.getById(env.DB, parsed.targetId);
          if (!existingDep) {
            throw new NotFoundError(`Deposit request ${parsed.targetId} not found`);
          }
          if (!['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO'].includes(existingDep.status)) {
            throw new ConflictError(`Deposit ${existingDep.deposit_id} is already in state ${existingDep.status}`);
          }
          if (parsed.version !== undefined && existingDep.version !== parsed.version) {
            throw new ConflictError('Deposit request was updated concurrently; refresh console.');
          }

          const sessionState = parsed.action === 'app' ? 'AWAITING_DEPOSIT_EVIDENCE' : 'AWAITING_DEPOSIT_NOTE';
          const pendingDecision =
            parsed.action === 'app'
              ? 'APPROVED_MANUAL_CREDITED'
              : parsed.action === 'rej'
              ? 'REJECTED'
              : 'NEEDS_INFO';

          await executeAtomicBatch(env.DB, [
            adminRepository.prepareUpsertSession(env.DB, {
              adminId: userId,
              sessionState,
              targetCustomerId: existingDep.customer_id,
              targetTicketId: existingDep.ticket_id,
              targetDepositId: existingDep.deposit_id,
              pendingDecision,
              targetExpectedVersion: existingDep.version,
              nowMs,
            }),
          ]);

          const prompt =
            parsed.action === 'app'
              ? `🔐 Enter external <b>Admin Operation Evidence Ref</b> to record manual completion for Deposit <code>${escapeHtml(existingDep.deposit_id)}</code> (v${existingDep.version}), or send <code>/cancel</code>:`
              : `📝 Enter mandatory <b>decision note</b> for marking Deposit <code>${escapeHtml(existingDep.deposit_id)}</code> as <b>${pendingDecision}</b> (v${existingDep.version}), or send <code>/cancel</code>:`;

          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `dep_cb_prompt:${cb.id}`,
            eventType: 'ADMIN_DECISION_PROMPT',
            aggregateType: 'DEPOSIT',
            aggregateId: existingDep.deposit_id,
            targetChatId: userId,
            text: prompt,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Reply in private chat.');
          return;
        }
      }

      if (parsed.namespace === 'wd') {
        if (parsed.action === 'meth') {
          const res = await withdrawalService.handleMethodSelection(env, userId, parsed.targetId, nowMs);
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `wd_meth:${cb.id}`,
            eventType: 'WIZARD_STEP',
            aggregateType: 'CUSTOMER',
            aggregateId: userId,
            targetChatId: chatId,
            text: res.promptText,
            correlationId,
            nowMs,
          });
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
        if (parsed.action === 'creq') {
          await withdrawalService.cancelByCustomer(env, {
            customerId: userId,
            withdrawalId: parsed.targetId,
            expectedVersion: parsed.version,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Withdrawal cancelled.');
          return;
        }
        if (parsed.action === 'rinfo') {
          const res = await withdrawalService.startNeedsInfoReplySession(env, {
            customerId: userId,
            withdrawalId: parsed.targetId,
            expectedVersion: parsed.version,
            nowMs,
          });
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `wd_rinfo:${cb.id}`,
            eventType: 'NEEDS_INFO_PROMPT',
            aggregateType: 'WITHDRAWAL',
            aggregateId: parsed.targetId,
            targetChatId: userId,
            text: res.promptText,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Send your reply now.');
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
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `wd_pii:${cb.id}`,
            eventType: 'SUPER_ADMIN_PII_DM',
            aggregateType: 'WITHDRAWAL',
            aggregateId: parsed.targetId,
            targetChatId: userId,
            text: `🔐 <b>Decrypted Destination (${escapeHtml(dec.withdrawalId)})</b>\n<code>${escapeHtml(dec.plaintextDestination)}</code>`,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Sent to private bot chat.');
          return;
        }
        if (parsed.action === 'rev' || parsed.action === 'app') {
          const currentWd = await withdrawalRepository.getById(env.DB, parsed.targetId);
          const expectedVersion = parsed.version ?? currentWd?.version ?? 1;
          const updatedWd = await withdrawalService.submitSuperAdminDecision(env, {
            adminId: userId,
            withdrawalId: parsed.targetId,
            newStatus: parsed.action === 'rev' ? 'UNDER_REVIEW' : 'APPROVED_FOR_PAYOUT',
            expectedVersion,
            correlationId,
            sourceUpdateId: update.update_id,
            nowMs,
          });
          await handoverService.sendAdminPrivateConsoleCard(env, {
            adminId: userId,
            ticketId: updatedWd.ticket_id,
            correlationId: `${correlationId}:wd_refresh`,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(
            env.TELEGRAM_BOT_TOKEN,
            cb.id,
            parsed.action === 'rev' ? 'Withdrawal moved to UNDER_REVIEW.' : 'Approved for manual payout.'
          );
          return;
        }
        if (parsed.action === 'paid' || parsed.action === 'rej' || parsed.action === 'info') {
          const adminRow = await adminRepository.getActiveAdmin(env.DB, userId);
          if (!adminRow || adminRow.role !== 'SUPER_ADMIN') {
            await auditRepository.appendImmediate(env.DB, {
              actorId: userId,
              actorRole: adminRow?.role ?? 'UNAUTHORIZED',
              action: 'UNAUTHORIZED_WITHDRAWAL_CALLBACK_ATTEMPT',
              resourceType: 'WITHDRAWAL',
              resourceId: parsed.targetId,
              result: 'DENIED',
              afterState: { action: parsed.action },
              reason: 'Only SUPER_ADMIN may initiate withdrawal decision callbacks',
              correlationId,
              sourceUpdateId: update.update_id,
              nowMs,
            });
            throw new AuthorizationError('Only SUPER_ADMIN is authorized to make financial withdrawal decisions');
          }
          if (adminRow.has_started_bot !== 1) {
            throw new AuthorizationError('Please send /start to the bot in private chat first.');
          }
          const existingWd = await withdrawalRepository.getById(env.DB, parsed.targetId);
          if (!existingWd) {
            throw new NotFoundError(`Withdrawal request ${parsed.targetId} not found`);
          }
          const allowedStatuses =
            parsed.action === 'paid'
              ? ['APPROVED_FOR_PAYOUT']
              : ['UNDER_REVIEW', 'APPROVED_FOR_PAYOUT'];
          if (!allowedStatuses.includes(existingWd.status)) {
            throw new ConflictError(
              `Withdrawal ${existingWd.withdrawal_id} in state ${existingWd.status} cannot transition via ${parsed.action}`
            );
          }
          if (parsed.version !== undefined && existingWd.version !== parsed.version) {
            throw new ConflictError('Withdrawal request was updated concurrently; refresh console.');
          }

          const sessionState =
            parsed.action === 'paid' ? 'AWAITING_WITHDRAWAL_EVIDENCE' : 'AWAITING_WITHDRAWAL_NOTE';
          const pendingDecision =
            parsed.action === 'paid'
              ? 'PAID_RECORDED'
              : parsed.action === 'rej'
              ? 'REJECTED'
              : 'NEEDS_INFO';

          await executeAtomicBatch(env.DB, [
            adminRepository.prepareUpsertSession(env.DB, {
              adminId: userId,
              sessionState,
              targetCustomerId: existingWd.customer_id,
              targetTicketId: existingWd.ticket_id,
              targetWithdrawalId: existingWd.withdrawal_id,
              pendingDecision,
              targetExpectedVersion: existingWd.version,
              nowMs,
            }),
          ]);

          const prompt =
            parsed.action === 'paid'
              ? `💳 Enter external <b>Payment Evidence Ref</b> to record manual payout completion for Withdrawal <code>${escapeHtml(existingWd.withdrawal_id)}</code> (v${existingWd.version}), or send <code>/cancel</code>:`
              : `📝 Enter mandatory <b>decision note</b> for marking Withdrawal <code>${escapeHtml(existingWd.withdrawal_id)}</code> as <b>${pendingDecision}</b> (v${existingWd.version}), or send <code>/cancel</code>:`;

          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `wd_cb_prompt:${cb.id}`,
            eventType: 'ADMIN_DECISION_PROMPT',
            aggregateType: 'WITHDRAWAL',
            aggregateId: existingWd.withdrawal_id,
            targetChatId: userId,
            text: prompt,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Reply in private chat.');
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
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Ticket claimed! Console sent to DM.');
          return;
        }
        if (parsed.action === 'reply') {
          const adminRow = await adminRepository.getActiveAdmin(env.DB, userId);
          if (!adminRow || !adminRepository.hasPermission(adminRow, 'ticket.reply')) {
            throw new AuthorizationError('Active administrator with ticket.reply permission required');
          }
          if (adminRow.has_started_bot !== 1) {
            throw new AuthorizationError('Please send /start to the bot in private chat first.');
          }
          const ticket = await ticketRepository.getById(env.DB, parsed.targetId);
          if (!ticket) {
            throw new NotFoundError(`Ticket ${parsed.targetId} not found`);
          }
          if (ticket.assigned_admin_id !== userId && adminRow.role !== 'SUPER_ADMIN') {
            throw new AuthorizationError('Only the assigned administrator or SUPER_ADMIN can reply on this ticket');
          }
          if (parsed.version !== undefined && ticket.version !== parsed.version) {
            throw new ConflictError('Ticket state changed concurrently; refresh console.');
          }

          await executeAtomicBatch(env.DB, [
            adminRepository.prepareUpsertSession(env.DB, {
              adminId: userId,
              sessionState: 'REPLYING_TO_CUSTOMER',
              targetCustomerId: ticket.customer_id,
              targetTicketId: ticket.ticket_id,
              targetExpectedVersion: ticket.version,
              nowMs,
            }),
          ]);
          await this.sendSimpleOutboxReply(env, {
            idempotencyKey: `tk_reply_prompt:${cb.id}`,
            eventType: 'ADMIN_REPLY_PROMPT',
            aggregateType: 'TICKET',
            aggregateId: ticket.ticket_id,
            targetChatId: userId,
            text: `💬 Type your reply to Customer <code>${escapeHtml(ticket.customer_id)}</code> (Ticket <code>${escapeHtml(ticket.ticket_id)}</code>), or send <code>/cancel</code>:`,
            correlationId,
            nowMs,
          });
          await telegramService.answerCallbackBestEffort(env.TELEGRAM_BOT_TOKEN, cb.id, 'Send your reply in private chat.');
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

    await this.sendSimpleOutboxReply(env, {
      idempotencyKey: `menu_open:${updateId}:${menuCode}`,
      eventType: 'MENU_RESPONSE',
      aggregateType: 'CUSTOMER',
      aggregateId: customerId,
      targetChatId: customerId,
      text,
      correlationId,
      nowMs,
    });
  },
};
