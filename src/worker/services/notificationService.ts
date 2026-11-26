import type { ConfigRow, DepositRequestRow, LanguageCode, SlipReviewRow, SupportTicketRow, WithdrawalRequestRow } from '../types/domain';
import { configRepository } from '../repositories/configRepository';
import { encodeCallbackData } from '../lib/callbackCodec';
import { escapeHtml } from '../lib/textChunker';

export const STANDARD_REQUEST_ACK_MY =
  'သင့် Request ကို လက်ခံရရှိပါပြီ။ Admin မှ စစ်ဆေးဆောင်ရွက်နေပါသည်။ ငွေသွင်း/ငွေထုတ် ပြီးစီးကြောင်း အတည်ပြုချက် မရမချင်း အောင်မြင်ပြီးဟု မယူဆပါနှင့်။';

export const STANDARD_REQUEST_ACK_EN =
  'Your request has been received and is being reviewed by an Administrator. Do not consider any deposit or withdrawal completed until you receive an explicit confirmation from an Administrator.';

export const STANDARD_SLIP_ACK_MY =
  'သင့်ပုံကို လက်ခံရရှိပါပြီ။ Admin Team မှ စစ်ဆေးပေးနေပါတယ်။ ငွေလွှဲအောင်မြင်ကြောင်း အတည်ပြုပြီးမှသာ သင့်ကို ပြန်လည်အကြောင်းကြားပေးပါမယ်။ ကျေးဇူးပြု၍ ခဏစောင့်ဆိုင်းပေးပါ။';

export const ANTI_PHISHING_WARNING_MY =
  '⚠️ သတိပြုရန် - မည်သည့်အခါမှ Password, PIN နံပါတ် သို့မဟုတ် OTP ကုဒ်များကို လုံးဝ မပေးပို့ပါနှင့်။';

export const ANTI_PHISHING_WARNING_EN =
  '⚠️ SECURITY WARNING: Never share your Password, PIN, or OTP codes.';

export const notificationService = {
  buildCustomerMainMenuKeyboard(config: ConfigRow, lang: LanguageCode, officialChannelUrl: string): Record<string, unknown> {
    const buttons = configRepository.parseMenuButtons(config);
    const rows: Array<Array<Record<string, unknown>>> = [];

    for (const btn of buttons) {
      const label = lang === 'en' ? btn.labelEn : btn.labelMy;
      rows.push([
        {
          text: label,
          callback_data: encodeCallbackData({
            namespace: 'mnu',
            action: 'open',
            targetId: btn.code,
          }),
        },
      ]);
    }

    // Language toggle + Official channel row
    rows.push([
      {
        text: lang === 'my' ? '🌐 English' : '🌐 မြန်မာဘာသာ',
        callback_data: encodeCallbackData({
          namespace: 'mnu',
          action: 'lang',
          targetId: lang === 'my' ? 'en' : 'my',
        }),
      },
      {
        text: '📢 Official Channel',
        url: officialChannelUrl || 'https://t.me/slotmyanmar77777',
      },
    ]);

    return { inline_keyboard: rows };
  },

  buildAdminGroupTicketCard(params: {
    ticket: SupportTicketRow;
    customerFirstName: string;
    summaryText: string;
    duplicateBanner?: string | null;
  }): { text: string; replyMarkup?: Record<string, unknown> } {
    const lines = [
      `🎫 <b>Support Ticket #${escapeHtml(params.ticket.ticket_id)}</b>`,
      `• <b>Type:</b> ${escapeHtml(params.ticket.ticket_type)}`,
      `• <b>Status:</b> ${escapeHtml(params.ticket.status)}`,
      `• <b>Customer ID:</b> <code>${escapeHtml(params.ticket.customer_id)}</code> (${escapeHtml(params.customerFirstName)})`,
      `• <b>Summary:</b> ${escapeHtml(params.summaryText)}`,
    ];

    if (params.duplicateBanner) {
      lines.unshift(`<b>${escapeHtml(params.duplicateBanner)}</b>\n`);
    }

    if (params.ticket.status === 'OPEN') {
      return {
        text: lines.join('\n'),
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: '✋ Take Over Ticket',
                callback_data: encodeCallbackData({
                  namespace: 'tk',
                  action: 'claim',
                  targetId: params.ticket.ticket_id,
                  version: params.ticket.version,
                }),
              },
            ],
          ],
        },
      };
    }

    if (params.ticket.status === 'ASSIGNED') {
      lines.push(`• <b>Assigned Admin:</b> <code>${escapeHtml(params.ticket.assigned_admin_id ?? '')}</code>`);
    }

    return { text: lines.join('\n') };
  },

  buildAdminPrivateConsoleCard(params: {
    ticket: SupportTicketRow;
    customerFirstName: string;
    canReviewSlips: boolean;
    isSuperAdmin: boolean;
    slip?: SlipReviewRow | null;
    deposit?: DepositRequestRow | null;
    withdrawal?: WithdrawalRequestRow | null;
  }): { text: string; replyMarkup: Record<string, unknown> } {
    const lines = [
      `🛠 <b>Admin Ticket Console</b>`,
      `• <b>Ticket ID:</b> <code>${escapeHtml(params.ticket.ticket_id)}</code> (v${params.ticket.version})`,
      `• <b>Customer:</b> ${escapeHtml(params.customerFirstName)} (<code>${escapeHtml(params.ticket.customer_id)}</code>)`,
      `• <b>Type:</b> ${escapeHtml(params.ticket.ticket_type)} | <b>Status:</b> ${escapeHtml(params.ticket.status)}`,
    ];

    const keyboard: Array<Array<Record<string, unknown>>> = [
      [
        {
          text: '💬 Reply to Customer',
          callback_data: encodeCallbackData({
            namespace: 'tk',
            action: 'reply',
            targetId: params.ticket.ticket_id,
            version: params.ticket.version,
          }),
        },
        {
          text: '🔓 Release Ticket (Stay HUMAN)',
          callback_data: encodeCallbackData({
            namespace: 'tk',
            action: 'release',
            targetId: params.ticket.ticket_id,
            version: params.ticket.version,
          }),
        },
      ],
      [
        {
          text: '✅ Resolve (Stay HUMAN)',
          callback_data: encodeCallbackData({
            namespace: 'tk',
            action: 'res_hum',
            targetId: params.ticket.ticket_id,
            version: params.ticket.version,
          }),
        },
        {
          text: '🤖 Resolve & Return to AI',
          callback_data: encodeCallbackData({
            namespace: 'tk',
            action: 'res_ai',
            targetId: params.ticket.ticket_id,
            version: params.ticket.version,
          }),
        },
      ],
    ];

    if (params.slip) {
      lines.push(
        `\n🖼 <b>Slip Review:</b> <code>${escapeHtml(params.slip.slip_id)}</code> (${escapeHtml(params.slip.review_status)})`
      );
      if (params.slip.is_duplicate_warning === 1) {
        lines.push(`🚨 <b>DUPLICATE FILE_UNIQUE_ID WARNING</b>: Inspect transaction reference carefully!`);
      }
      if (params.canReviewSlips && ['RECEIVED', 'UNDER_REVIEW', 'NEEDS_INFO'].includes(params.slip.review_status)) {
        keyboard.push([
          {
            text: '✅ Approve Slip',
            callback_data: encodeCallbackData({
              namespace: 'sl',
              action: 'app',
              targetId: params.slip.slip_id,
              version: params.slip.version,
            }),
          },
          {
            text: '❌ Reject Slip',
            callback_data: encodeCallbackData({
              namespace: 'sl',
              action: 'rej',
              targetId: params.slip.slip_id,
              version: params.slip.version,
            }),
          },
          {
            text: '❓ Slip Needs Info',
            callback_data: encodeCallbackData({
              namespace: 'sl',
              action: 'info',
              targetId: params.slip.slip_id,
              version: params.slip.version,
            }),
          },
        ]);
      }
    }

    if (params.deposit) {
      lines.push(
        `\n💰 <b>Deposit Request:</b> <code>${escapeHtml(params.deposit.deposit_id)}</code>`,
        `• Amount: <b>${params.deposit.amount} ${escapeHtml(params.deposit.currency)}</b> via <b>${escapeHtml(params.deposit.method_code)}</b>`,
        `• Ref: <code>${escapeHtml(params.deposit.customer_reference_text ?? 'N/A')}</code>`,
        `• Status: <b>${escapeHtml(params.deposit.status)}</b>`
      );
      if (params.isSuperAdmin && ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO'].includes(params.deposit.status)) {
        keyboard.push([
          {
            text: '✅ Confirm Manual Deposit Credited',
            callback_data: encodeCallbackData({
              namespace: 'dep',
              action: 'app',
              targetId: params.deposit.deposit_id,
              version: params.deposit.version,
            }),
          },
          {
            text: '❌ Reject Deposit',
            callback_data: encodeCallbackData({
              namespace: 'dep',
              action: 'rej',
              targetId: params.deposit.deposit_id,
              version: params.deposit.version,
            }),
          },
          {
            text: '❓ Deposit Needs Info',
            callback_data: encodeCallbackData({
              namespace: 'dep',
              action: 'info',
              targetId: params.deposit.deposit_id,
              version: params.deposit.version,
            }),
          },
        ]);
      }
    }

    if (params.withdrawal) {
      lines.push(
        `\n💸 <b>Withdrawal Request:</b> <code>${escapeHtml(params.withdrawal.withdrawal_id)}</code>`,
        `• Amount: <b>${params.withdrawal.amount} ${escapeHtml(params.withdrawal.currency)}</b> via <b>${escapeHtml(params.withdrawal.method_code)}</b>`,
        `• Masked Destination: <code>${escapeHtml(params.withdrawal.destination_masked)}</code>`,
        `• Status: <b>${escapeHtml(params.withdrawal.status)}</b>`
      );
      if (params.isSuperAdmin) {
        const wdRow: Array<Record<string, unknown>> = [
          {
            text: '🔐 View Encrypted Destination',
            callback_data: encodeCallbackData({
              namespace: 'wd',
              action: 'pii',
              targetId: params.withdrawal.withdrawal_id,
              version: params.withdrawal.version,
            }),
          },
        ];
        if (['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO'].includes(params.withdrawal.status)) {
          wdRow.push(
            {
              text: '✅ Approve for Payout',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'app',
                targetId: params.withdrawal.withdrawal_id,
                version: params.withdrawal.version,
              }),
            },
            {
              text: '❌ Reject',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'rej',
                targetId: params.withdrawal.withdrawal_id,
                version: params.withdrawal.version,
              }),
            }
          );
        }
        if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED_FOR_PAYOUT'].includes(params.withdrawal.status)) {
          keyboard.push([
            {
              text: '💳 Record External Payout Evidence (Mark Paid)',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'paid',
                targetId: params.withdrawal.withdrawal_id,
                version: params.withdrawal.version,
              }),
            },
            {
              text: '❓ Withdrawal Needs Info',
              callback_data: encodeCallbackData({
                namespace: 'wd',
                action: 'info',
                targetId: params.withdrawal.withdrawal_id,
                version: params.withdrawal.version,
              }),
            },
          ]);
        }
        keyboard.push(wdRow);
      }
    }

    return {
      text: lines.join('\n'),
      replyMarkup: { inline_keyboard: keyboard },
    };
  },
};
