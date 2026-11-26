/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';

type Lang = 'my' | 'en';

interface VerificationRow {
  labelMy: string;
  labelEn: string;
  command: string;
  resultMy: string;
  resultEn: string;
}

interface StagingStep {
  number: string;
  titleMy: string;
  titleEn: string;
  detailMy: string;
  detailEn: string;
  snippet?: string;
}

const VERIFICATION_ROWS: VerificationRow[] = [
  {
    labelMy: 'TypeScript စစ်ဆေးမှု',
    labelEn: 'Static Typecheck',
    command: 'npm run lint',
    resultMy: '0 errors',
    resultEn: '0 errors',
  },
  {
    labelMy: 'Cloudflare Worker ESM Build',
    labelEn: 'Cloudflare Worker ESM Build',
    command: 'npm run build:worker',
    resultMy: 'dist-worker/index.js အောင်မြင်',
    resultEn: 'dist-worker/index.js compiled',
  },
  {
    labelMy: 'SQLite D1 Unit & Regression Tests',
    labelEn: 'SQLite D1 Unit & Regression Tests',
    command: 'npm run test:unit',
    resultMy: '30 / 30 အောင်မြင်',
    resultEn: '30 / 30 passed',
  },
  {
    labelMy: 'Real Cloudflare workerd + Miniflare D1',
    labelEn: 'Real Cloudflare workerd + Miniflare D1',
    command: 'npm run test:workerd',
    resultMy: '4 / 4 အောင်မြင်',
    resultEn: '4 / 4 passed',
  },
  {
    labelMy: 'Local Wrangler D1 Migrations (0001–0004)',
    labelEn: 'Local Wrangler D1 Migrations (0001–0004)',
    command: 'wrangler d1 migrations apply --local',
    resultMy: '4 / 4 migrations (18 tables)',
    resultEn: '4 / 4 migrations (18 tables)',
  },
];

const STAGING_STEPS: StagingStep[] = [
  {
    number: '01',
    titleMy: 'Cloudflare D1 နှင့် Queues ဖန်တီးပါ',
    titleEn: 'Provision Cloudflare D1 and Queues',
    detailMy:
      'Staging အတွက် vip-gaming-d1-staging database နှင့် vip-outbox-queue-staging, vip-outbox-dlq-staging queue နှစ်ခုကို Cloudflare dashboard သို့မဟုတ် Wrangler CLI ဖြင့် ဖန်တီးပြီး wrangler.jsonc ထဲရှိ placeholder database_id နေရာတွင် ထည့်သွင်းပါ။',
    detailEn:
      'Create the vip-gaming-d1-staging D1 database along with vip-outbox-queue-staging and vip-outbox-dlq-staging queues, then replace the placeholder database_id inside wrangler.jsonc.',
    snippet:
      'wrangler d1 create vip-gaming-d1-staging\nwrangler queues create vip-outbox-queue-staging\nwrangler queues create vip-outbox-dlq-staging',
  },
  {
    number: '02',
    titleMy: 'Staging Configuration တန်ဖိုးများ ဖြည့်သွင်းပါ',
    titleEn: 'Set Non-Secret Staging Variables',
    detailMy:
      'wrangler.jsonc (env.staging.vars) အတွင်း TELEGRAM_BOT_USERNAME (@ မပါဘဲ), TELEGRAM_ADMIN_GROUP_ID (Admin Supergroup ID), နှင့် SUPER_ADMIN_IDS (Super Admin Telegram User ID များ) ကို သတ်မှတ်ပါ။',
    detailEn:
      'Populate TELEGRAM_BOT_USERNAME (without @), TELEGRAM_ADMIN_GROUP_ID (negative supergroup chat ID), and SUPER_ADMIN_IDS (comma-separated Telegram user IDs) inside wrangler.jsonc under env.staging.vars.',
  },
  {
    number: '03',
    titleMy: 'Cloudflare Secrets များ သွင်းပါ',
    titleEn: 'Upload Required Cloudflare Secrets',
    detailMy:
      'Secret များကို code ထဲတွင် မထည့်ဘဲ wrangler secret put ဖြင့်သာ သွင်းပါ။ WITHDRAWAL_PII_ENCRYPTION_KEY သည် 32-byte random key (openssl rand -base64 32) ဖြစ်ရမည်။',
    detailEn:
      'Upload all secrets via wrangler secret put (never commit secrets). Generate WITHDRAWAL_PII_ENCRYPTION_KEY as strict 32-byte random key material using openssl rand -base64 32.',
    snippet:
      'wrangler secret put TELEGRAM_BOT_TOKEN --env staging\nwrangler secret put TELEGRAM_WEBHOOK_SECRET --env staging\nwrangler secret put GEMINI_API_KEY --env staging\nwrangler secret put WITHDRAWAL_PII_ENCRYPTION_KEY --env staging',
  },
  {
    number: '04',
    titleMy: 'Remote D1 Migration နှင့် Staging Deploy လုပ်ပါ',
    titleEn: 'Apply Remote Migrations and Deploy Worker',
    detailMy:
      'Migration 0001 မှ 0004 အထိကို remote Staging D1 ပေါ်တွင် apply လုပ်ပြီး Staging Worker ကို deploy တင်ပါ။',
    detailEn:
      'Apply migrations 0001 through 0004 to the remote Staging D1 database, then deploy the Cloudflare Worker to the staging environment.',
    snippet:
      'wrangler d1 migrations apply vip-gaming-d1-staging --remote --env staging\nwrangler deploy --env staging',
  },
  {
    number: '05',
    titleMy: 'Telegram Webhook ချိတ်ဆက်ပြီး Super Admin /start လုပ်ပါ',
    titleEn: 'Register Telegram Webhook and Activate Super Admin Chat',
    detailMy:
      'Telegram setWebhook ကို secret_token နှင့်တကွ ချိတ်ဆက်ပါ။ ထို့နောက် Super Admin တစ်ဦးချင်းစီသည် Bot နှင့် private chat တွင် /start ပေးပို့၍ Private Console နှင့် PII DM ကို ဖွင့်ပါ။ FAQ/Prompt စစ်ဆေးပြီးမှသာ /toggle_ai ဖြင့် AI ကို ဖွင့်ပါ (bootstrap တွင် ai_enabled = 0 ဖြင့် လုံခြုံစွာ စတင်ထားပါသည်)။',
    detailEn:
      'Register your Telegram webhook pointing to https://<staging-worker-url>/webhook with secret_token matching TELEGRAM_WEBHOOK_SECRET. Each SUPER_ADMIN must send /start in private chat with the bot to activate private console & PII DM delivery. Enable AI explicitly with /toggle_ai once FAQs are confirmed (bootstraps safely with ai_enabled = 0).',
  },
];

export default function App() {
  const [lang, setLang] = useState<Lang>('my');
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(id);
      window.setTimeout(() => {
        setCopiedIndex((prev) => (prev === id ? null : prev));
      }, 1800);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f7f4] text-zinc-900">
      {/* Top Bar: 3-zone contract */}
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-[#f8f7f4]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-6 py-4">
          <a
            href="#overview"
            className="text-base font-semibold tracking-tight text-zinc-900 whitespace-nowrap shrink-0"
          >
            7777club Support Engine
          </a>

          <nav
            aria-label="Primary"
            className="hidden md:flex items-center gap-7 text-sm text-zinc-600"
          >
            <a
              href="#overview"
              className="hover:text-zinc-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              {lang === 'my' ? 'အကျဉ်းချုပ်' : 'Overview'}
            </a>
            <a
              href="#workflows"
              className="hover:text-zinc-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              {lang === 'my' ? 'Telegram လုပ်ငန်းစဉ်' : 'Workflows'}
            </a>
            <a
              href="#verification"
              className="hover:text-zinc-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              {lang === 'my' ? 'စစ်ဆေးချက်များ' : 'Verification'}
            </a>
            <a
              href="#staging"
              className="hover:text-zinc-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              {lang === 'my' ? 'Staging အဆင့်များ' : 'Staging Steps'}
            </a>
          </nav>

          <button
            type="button"
            onClick={() => setLang((prev) => (prev === 'my' ? 'en' : 'my'))}
            className="px-4 py-2 text-xs font-medium text-white bg-[#1e3a8a] hover:bg-[#172e6e] rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1e3a8a] whitespace-nowrap shrink-0 cursor-pointer"
          >
            {lang === 'my' ? 'Switch to English' : 'မြန်မာဘာသာဖြင့်ဖတ်ရန်'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12 lg:py-16 space-y-20">
        {/* 01. Hero & Architectural Scope Notice */}
        <section id="overview" className="scroll-mt-24 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          <div className="lg:col-span-7 space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>Telegram-Only Bot</span>
              <span aria-hidden="true">·</span>
              <span>Cloudflare Workers ESM</span>
              <span aria-hidden="true">·</span>
              <span>Phase 2 v3.0.x</span>
            </div>

            <h1 className="text-3xl sm:text-4xl lg:text-[2.6rem] font-semibold tracking-tight leading-[1.2] text-zinc-900 text-balance">
              {lang === 'my'
                ? 'Telegram-only AI Customer Support & Manual Admin Bot'
                : 'Telegram-Only AI Customer Support & Manual Admin Bot'}
            </h1>

            <p className="text-base leading-relaxed text-zinc-600 max-w-2xl">
              {lang === 'my'
                ? 'ဤစာမျက်နှာသည် Read-only အသိပေးချက် စာမျက်နှာသာ ဖြစ်ပါသည်။ 7777club စနစ်တွင် Website Dashboard သို့မဟုတ် Telegram Mini App မပါဝင်ဘဲ Customer နှင့် Admin လုပ်ငန်းစဉ်အားလုံးကို Telegram Bot နှင့် Cloudflare Workers မှတစ်ဆင့်သာ လုပ်ဆောင်ရန် တည်ဆောက်ထားပါသည်။'
                : 'This preview is a read-only informational notice only. By design, the 7777club system has no web admin dashboard and no Telegram Mini App—all customer inquiries, manual deposit/withdrawal intake, and authorized admin operations run exclusively inside Telegram on Cloudflare Workers.'}
            </p>
          </div>

          {/* Institutional Definition List */}
          <aside className="lg:col-span-5 bg-white border border-stone-200 rounded-lg p-6">
            <h2 className="text-sm font-semibold text-zinc-900 pb-4 border-b border-stone-200">
              {lang === 'my' ? 'စနစ်၏ အဓိကသတ်မှတ်ချက်များ' : 'System Architecture Summary'}
            </h2>
            <dl className="divide-y divide-stone-200 text-sm">
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'Runtime' : 'Runtime'}</dt>
                <dd className="font-mono text-xs text-zinc-900 text-right">Cloudflare Workers + Hono</dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'Database' : 'Database'}</dt>
                <dd className="font-mono text-xs text-zinc-900 text-right tabular-nums">D1 SQLite · 18 tables · 4 migrations</dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'Async Delivery' : 'Async Delivery'}</dt>
                <dd className="font-mono text-xs text-zinc-900 text-right">Outbox + DLQ + 3 Cron Triggers</dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'Endpoints' : 'Endpoints'}</dt>
                <dd className="font-mono text-xs text-zinc-900 text-right">POST /webhook · GET /healthz</dd>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'ငွေကြေးစည်းကမ်း' : 'Financial Policy'}</dt>
                <dd className="text-zinc-900 font-medium text-right">
                  {lang === 'my' ? 'Admin ကိုယ်တိုင်သာ (AI မဆုံးဖြတ်ပါ)' : 'Manual Admin Only (Zero Auto-Payout)'}
                </dd>
              </div>
              <div className="pt-3 flex justify-between gap-4">
                <dt className="text-zinc-500">{lang === 'my' ? 'Deployment Gate' : 'Deployment Gate'}</dt>
                <dd className="font-mono text-xs font-medium text-[#1e3a8a] text-right">
                  LOCALLY VERIFIED · STAGING PENDING OWNER
                </dd>
              </div>
            </dl>
          </aside>
        </section>

        <hr className="border-stone-200" />

        {/* 02. Workflows & Non-Negotiable Safety Rules */}
        <section id="workflows" className="scroll-mt-24 space-y-8">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
              {lang === 'my' ? '01. Telegram လုပ်ငန်းစဉ်နှင့် လုံခြုံရေးစည်းကမ်းများ' : '01. Telegram Workflows & Safety Boundaries'}
            </h2>
            <p className="text-sm text-zinc-600 max-w-2xl">
              {lang === 'my'
                ? 'Customer များနှင့် Admin များအတွက် လုပ်ပိုင်ခွင့်နှင့် အချက်အလက်လုံခြုံရေးကို တိကျစွာ ပိုင်းခြားထားပါသည်။'
                : 'Customer intake, AI FAQ responses, and manual human administrator operations are strictly segregated inside Telegram.'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-white border border-stone-200 rounded-lg p-6 space-y-4">
              <h3 className="text-base font-semibold text-zinc-900">
                {lang === 'my' ? 'Customer Telegram အတွေ့အကြုံ' : 'Customer Telegram Experience'}
              </h3>
              <ul className="space-y-3 text-sm leading-relaxed text-zinc-600">
                <li className="pb-3 border-b border-stone-100">
                  {lang === 'my'
                    ? 'မြန်မာ / English နှစ်ဘာသာဖြင့် /start မီနူး၊ AI FAQ အလိုအလျောက်ဖြေကြားမှုနှင့် Human Admin ထံ လွှဲပြောင်းချိတ်ဆက်မှု။'
                    : 'Bilingual Burmese/English /start menu, Gemini FAQ auto-replies grounded in approved knowledge base, and instant handover to human agents.'}
                </li>
                <li className="pb-3 border-b border-stone-100">
                  {lang === 'my'
                    ? 'ငွေသွင်း (Deposit) နှင့် ငွေထုတ် (Withdraw) request များကို အဆင့်ဆင့် လက်ခံမှတ်တမ်းတင်ခြင်း၊ Cancel လုပ်ခြင်းနှင့် NEEDS_INFO ပြန်လည်ဖြေကြားခြင်း။'
                    : 'Guided Deposit and Withdrawal request intake wizards with idempotent submission, customer cancellation, and NEEDS_INFO follow-up replies.'}
                </li>
                <li>
                  {lang === 'my'
                    ? 'Password, PIN, OTP ပါဝင်သော စာသားများကို အလိုအလျောက် ပိတ်ဆို့ကာကွယ်ထားပြီး ငွေလက်ခံအကောင့်အချက်အလက်ကို AES-256-GCM ဖြင့် သိမ်းဆည်းပါသည်။'
                    : 'Automatic blocking of Password/PIN/OTP inputs and strict AES-256-GCM encryption with per-record AAD for withdrawal payout destinations.'}
                </li>
              </ul>
            </div>

            <div className="bg-white border border-stone-200 rounded-lg p-6 space-y-4">
              <h3 className="text-base font-semibold text-zinc-900">
                {lang === 'my' ? 'Admin Telegram စီမံခန့်ခွဲမှု' : 'Authorized Admin Telegram Management'}
              </h3>
              <ul className="space-y-3 text-sm leading-relaxed text-zinc-600">
                <li className="pb-3 border-b border-stone-100">
                  {lang === 'my'
                    ? 'Ticket claim ပြုလုပ်သည်နှင့် Admin ၏ Private Bot Chat ထဲသို့ Private Console Card တိုက်ရိုက်ပေးပို့ပြီး Group chat ထဲတွင် PII မပေါက်ကြားစေရန် ကာကွယ်ထားပါသည်။'
                    : 'Claiming a ticket immediately delivers a Private Console Card to the admin DM—never exposing sensitive payout details inside group chats.'}
                </li>
                <li className="pb-3 border-b border-stone-100">
                  {lang === 'my'
                    ? 'ငွေသွင်း/ငွေထုတ် အတည်ပြုခြင်း၊ ပယ်ချခြင်းနှင့် ငွေလက်ခံအကောင့် ကြည့်ရှုခြင်း (audit-before-decrypt) ကို SUPER_ADMIN တစ်မျိုးတည်းသာ လုပ်ဆောင်ခွင့်ရှိပါသည်။'
                    : 'Financial decisions (with mandatory external evidence references) and audit-before-decrypt PII viewing are restricted strictly to SUPER_ADMIN.'}
                </li>
                <li>
                  {lang === 'my'
                    ? 'AI သည် ငွေသွင်း/ငွေထုတ် အတည်ပြုခြင်း၊ ငွေလွှဲခြင်း သို့မဟုတ် balance ပြင်ဆင်ခြင်း လုံးဝပြုလုပ်ခွင့်မရှိဘဲ ဆောင်ရွက်ချက်တိုင်းကို hash-chained audit_logs တွင် သိမ်းဆည်းပါသည်။'
                    : 'AI has zero authority to approve, reject, credit, debit, or claim payout completion. Every material state transition is recorded in a fork-proof hash-chained audit log.'}
                </li>
              </ul>
            </div>
          </div>
        </section>

        <hr className="border-stone-200" />

        {/* 03. Local Verification Record */}
        <section id="verification" className="scroll-mt-24 space-y-6">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
              {lang === 'my' ? '02. Local စစ်ဆေးအောင်မြင်ပြီးသော မှတ်တမ်း' : '02. Verified Local Checks'}
            </h2>
            <p className="text-sm text-zinc-600 max-w-2xl">
              {lang === 'my'
                ? 'Findings F-01 မှ F-12 အထိ ပြင်ဆင်ပြီးနောက် SQLite unit tests နှင့် real Cloudflare workerd + Miniflare D1 runtime tests နှစ်မျိုးလုံးကို သီးခြားစီ စစ်ဆေးအောင်မြင်ထားပါသည်။'
                : 'Following remediation of findings F-01 through F-12, both the SQLite D1 adapter unit/regression suite and the real Cloudflare workerd + Miniflare D1 runtime suite pass independently.'}
            </p>
          </div>

          <div className="bg-white border border-stone-200 rounded-lg overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs text-zinc-500">
                  <th className="py-3.5 px-5 font-medium">{lang === 'my' ? 'စစ်ဆေးမှု' : 'Check'}</th>
                  <th className="py-3.5 px-5 font-medium">{lang === 'my' ? 'Command' : 'Command'}</th>
                  <th className="py-3.5 px-5 font-medium text-right">{lang === 'my' ? 'ရလဒ်' : 'Verified Result'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {VERIFICATION_ROWS.map((row) => (
                  <tr key={row.command}>
                    <td className="py-3.5 px-5 font-medium text-zinc-900">
                      {lang === 'my' ? row.labelMy : row.labelEn}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-xs text-zinc-600">
                      {row.command}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-xs text-zinc-900 text-right tabular-nums">
                      {lang === 'my' ? row.resultMy : row.resultEn}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <hr className="border-stone-200" />

        {/* 04. Cloudflare Staging Deployment Checklist */}
        <section id="staging" className="scroll-mt-24 space-y-8">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
              {lang === 'my' ? '03. Cloudflare Staging Deploy လုပ်ရန် အဆင့်များ' : '03. Cloudflare Staging Deployment Checklist'}
            </h2>
            <p className="text-sm text-zinc-600 max-w-2xl">
              {lang === 'my'
                ? 'ဤ workspace မှ remote Cloudflare resource သို့မဟုတ် Telegram webhook များကို မပြောင်းလဲထားပါ။ Staging စတင်ရန် အောက်ပါအဆင့် ၅ ဆင့်ကို Owner ၏ Cloudflare account တွင် လုပ်ဆောင်ပါ။'
                : 'No remote Cloudflare resources or Telegram webhooks have been modified from this workspace. Complete these five owner-side steps to bring up Cloudflare Staging.'}
            </p>
          </div>

          <ol className="divide-y divide-stone-200 border-t border-b border-stone-200 bg-white rounded-lg border">
            {STAGING_STEPS.map((step) => (
              <li key={step.number} className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-8">
                <div className="lg:col-span-4 space-y-1">
                  <div className="font-mono text-xs text-zinc-400 tabular-nums">{step.number}</div>
                  <h3 className="text-base font-semibold text-zinc-900">
                    {lang === 'my' ? step.titleMy : step.titleEn}
                  </h3>
                </div>
                <div className="lg:col-span-8 space-y-3">
                  <p className="text-sm leading-relaxed text-zinc-600">
                    {lang === 'my' ? step.detailMy : step.detailEn}
                  </p>
                  {step.snippet && (
                    <div className="rounded-md border border-stone-200 bg-[#f8f7f4] p-4 flex items-start justify-between gap-4">
                      <pre className="font-mono text-xs leading-relaxed text-zinc-800 overflow-x-auto whitespace-pre">
                        {step.snippet}
                      </pre>
                      <button
                        type="button"
                        onClick={() => handleCopy(step.number, step.snippet!)}
                        className="px-3 py-1.5 text-xs font-medium text-zinc-700 bg-white border border-stone-200 hover:bg-stone-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {copiedIndex === step.number
                          ? lang === 'my'
                            ? 'ကူးယူပြီး'
                            : 'Copied'
                          : lang === 'my'
                          ? 'ကူးယူရန်'
                          : 'Copy'}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-stone-200 mt-16">
        <div className="mx-auto max-w-6xl px-6 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-zinc-500">
          <span>7777club VIP Gaming Telegram AI Customer Support System</span>
          <span>
            {lang === 'my'
              ? 'Read-Only Preview Notice · Website Dashboard သို့မဟုတ် Mini App မဟုတ်ပါ'
              : 'Read-Only Preview Notice · Not a Web Admin Dashboard or Telegram Mini App'}
          </span>
        </div>
      </footer>
    </div>
  );
}
