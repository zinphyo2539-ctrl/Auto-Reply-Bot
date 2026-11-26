import type { D1Database, D1PreparedStatement } from '../types/bindings';
import type { ConfigRow, FaqEntryRow, MenuButtonConfig, PaymentMethodConfig } from '../types/domain';

const FALLBACK_CONFIG: ConfigRow = {
  config_id: 'active',
  active_version: 1,
  ai_enabled: 0,
  welcome_text_my: 'မင်္ဂလာပါ 7777club Customer Support မှ ကြိုဆိုပါတယ်။',
  welcome_text_en: 'Welcome to 7777club Customer Support.',
  welcome_image_file_id: null,
  system_prompt: 'You are the support assistant for 7777club.',
  menu_buttons_json: JSON.stringify([
    { code: 'AI_SUPPORT', labelMy: '🤖 AI Customer Support', labelEn: '🤖 AI Customer Support' },
    { code: 'DEPOSIT', labelMy: '💰 ငွေသွင်းရန် (Deposit)', labelEn: '💰 Deposit' },
    { code: 'DEPOSIT_STATUS', labelMy: '📥 ငွေသွင်းမှတ်တမ်း (Deposit Status)', labelEn: '📥 Deposit Status' },
    { code: 'WITHDRAW', labelMy: '💸 ငွေထုတ်ရန် (Withdraw)', labelEn: '💸 Withdraw' },
    { code: 'WITHDRAWAL_STATUS', labelMy: '📋 ငွေထုတ်မှတ်တမ်း (Withdrawal Status)', labelEn: '📋 Withdrawal Status' },
    { code: 'CONTACT_SUPPORT', labelMy: '👨‍💼 Admin နှင့်ပြောရန် (Contact Support)', labelEn: '👨‍💼 Contact Support' },
  ]),
  payment_methods_json: JSON.stringify([
    {
      code: 'KBZPAY',
      nameMy: 'KBZPay',
      nameEn: 'KBZPay',
      enabled: true,
      instructionsMy: 'Admin အတည်ပြုထားသော KBZPay သို့သာ လွှဲပေးပါရန်။',
      instructionsEn: 'Transfer only to admin-confirmed KBZPay account.',
    },
    {
      code: 'WAVEPAY',
      nameMy: 'WavePay',
      nameEn: 'WavePay',
      enabled: true,
      instructionsMy: 'Admin အတည်ပြုထားသော WavePay သို့သာ လွှဲပေးပါရန်။',
      instructionsEn: 'Transfer only to admin-confirmed WavePay account.',
    },
  ]),
  min_deposit_amount: 1000,
  max_deposit_amount: 10000000,
  min_withdrawal_amount: 5000,
  max_withdrawal_amount: 10000000,
  currency: 'MMK',
  reminder_minutes: 30,
  escalation_minutes: 60,
  updated_by_admin_id: 'FALLBACK_DEFAULT',
  last_mutation_token: null,
  updated_at: 0,
};

export const configRepository = {
  async getActiveConfig(db: D1Database): Promise<ConfigRow> {
    const row = await db
      .prepare(`SELECT * FROM config WHERE config_id = 'active'`)
      .first<ConfigRow>();
    return row ?? FALLBACK_CONFIG;
  },

  parsePaymentMethods(config: ConfigRow): PaymentMethodConfig[] {
    try {
      const parsed = JSON.parse(config.payment_methods_json) as PaymentMethodConfig[];
      return Array.isArray(parsed) ? parsed.filter((m) => m.enabled) : [];
    } catch {
      return [];
    }
  },

  parseMenuButtons(config: ConfigRow): MenuButtonConfig[] {
    try {
      const parsed = JSON.parse(config.menu_buttons_json) as MenuButtonConfig[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  async listEnabledFaqs(db: D1Database): Promise<FaqEntryRow[]> {
    const res = await db
      .prepare(`SELECT * FROM faq_entries WHERE is_enabled = 1 ORDER BY display_order ASC, created_at ASC`)
      .all<FaqEntryRow>();
    return res.results;
  },

  prepareToggleAi(
    db: D1Database,
    params: {
      aiEnabled: boolean;
      actorAdminId: string;
      expectedVersion: number;
      mutationToken: string;
      nowMs: number;
    }
  ): D1PreparedStatement {
    return db
      .prepare(
        `UPDATE config
         SET ai_enabled = ?1,
             active_version = active_version + 1,
             updated_by_admin_id = ?2,
             last_mutation_token = ?3,
             updated_at = ?4
         WHERE config_id = 'active'
           AND active_version = ?5
           AND EXISTS (
             SELECT 1 FROM admins WHERE telegram_user_id = ?2 AND is_active = 1 AND role = 'SUPER_ADMIN'
           )
         RETURNING *`
      )
      .bind(
        params.aiEnabled ? 1 : 0,
        params.actorAdminId,
        params.mutationToken,
        params.nowMs,
        params.expectedVersion
      );
  },

  prepareSnapshotConfigVersion(
    db: D1Database,
    mutationToken: string,
    rollbackFromVersion: number | null = null
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO config_versions (
          version_number, ai_enabled, welcome_text_my, welcome_text_en,
          welcome_image_file_id, system_prompt, menu_buttons_json, payment_methods_json,
          faq_snapshot_json, min_deposit_amount, max_deposit_amount,
          min_withdrawal_amount, max_withdrawal_amount, currency,
          reminder_minutes, escalation_minutes, rollback_from_version,
          published_by_admin_id, published_at
        )
        SELECT
          active_version, ai_enabled, welcome_text_my, welcome_text_en,
          welcome_image_file_id, system_prompt, menu_buttons_json, payment_methods_json,
          '[]', min_deposit_amount, max_deposit_amount,
          min_withdrawal_amount, max_withdrawal_amount, currency,
          reminder_minutes, escalation_minutes, ?2,
          updated_by_admin_id, updated_at
        FROM config
        WHERE config_id = 'active' AND last_mutation_token = ?1`
      )
      .bind(mutationToken, rollbackFromVersion);
  },
};
