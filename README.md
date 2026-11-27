# 7777club VIP Gaming — Telegram AI Customer Support & Manual Admin Management Bot

## Overview

**7777club VIP Gaming Telegram AI Customer Support Bot** (`vip-gaming-bot`) is a Telegram-only AI customer support auto-reply and manual administrator request-management system running on **Cloudflare Workers**, **Hono**, **Cloudflare D1**, **Cloudflare Queues**, and **Cloudflare Cron Triggers**.

### Core Capabilities
- **Bilingual AI Customer Support & FAQ (`my` / `en`):** First-line responses powered by Gemini (`gemini-2.5-flash`) strictly grounded in the administrator-approved FAQ and system prompt knowledge base.
- **Manual-Only Deposit & Withdrawal Request Intake:** Guided conversational wizards with versioned session concurrency (`customer_sessions`), deterministic support-ticket association (`target_ticket_id`), and duplicate slip fingerprint detection (`slip_fingerprints`).
- **Strict Financial & RBAC Boundaries:**
  - Neither AI nor the bot ever executes financial transactions, transfers funds, approves payouts, or mutates customer balances.
  - All financial operations are performed manually outside the bot by authorized administrators and recorded with mandatory audit evidence (`admin_operation_evidence_ref` / `payment_evidence_ref`).
  - `SUPER_ADMIN` exclusively controls Deposit and Withdrawal approval/rejection/payout recording.
  - `SUPPORT_AGENT` handles general support tickets, customer replies, and slip triage, and is strictly blocked from withdrawal decisions and payout recording.
- **AES-256-GCM Withdrawal Destination PII Protection:** Payout destinations are encrypted immediately upon customer entry using AES-256-GCM (12-byte IV, 128-bit auth tag, canonical AAD `v304|purpose=...|customer_id=...|record_token=...|method_code=...|kv=N`), redacted in group notifications and logs, and decryptable only by an active `SUPER_ADMIN` inside an initialized private bot DM.
- **Immutable Versioned Audit Hash Chain:** Append-only `audit_logs` and `audit_retention_checkpoints` protected by SQLite immutability triggers (`BEFORE UPDATE` / `BEFORE DELETE`), `UNIQUE(prev_entry_hash)` linear chain serialization, and versioned length-prefixed canonical SHA-256 hashing (`hash_version = 2` with read-only `hash_version = 1` legacy verification).

---

## Worker Metadata & Architecture (Phase 3 — Architecture B Temporary Staging Mode)

| Property | Value |
| :--- | :--- |
| **Worker Name (Top-Level Target)** | `auto-reply-bot` |
| **Cloudflare System Service Tag** | `cf:service=auto-reply-bot` |
| **Deployment Mode** | Architecture B — Temporary Staging at Top-Level (`ENVIRONMENT = "staging"`) |
| **Dashboard Variable Persistence** | `"keep_vars": true` (Top-level only) |
| **Dashboard-Managed Variables** | `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_GROUP_ID`, `SUPER_ADMIN_IDS` (Omitted from `wrangler.jsonc` `vars` blocks) |
| **Required Secrets (`secret_text`)** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `WITHDRAWAL_PII_ENCRYPTION_KEY` |
| **Optional Rotation Secrets** | `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`, `WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS` |
| **Entry Point** | `src/worker/index.ts` |
| **Runtime Compatibility** | `compatibility_date = "2025-03-01"`, `compatibility_flags = ["nodejs_compat"]` |
| **HTTP Router** | Hono (`GET /healthz`, `POST /webhook`) |
| **Primary Database Binding** | `DB` (Cloudflare D1 `vip-gaming-d1-staging`, migrations in `./migrations`) |
| **Queue Producer Binding** | `OUTBOX_QUEUE` (Cloudflare Queues `vip-outbox-queue-staging`, DLQ `vip-outbox-dlq-staging`) |
| **Cron Triggers** | `* * * * *` (Outbox lease recovery), `*/5 * * * *` (SLA reminder & escalation), `0 20 * * *` (02:30 MMT daily retention & PII redaction) |

> **CRITICAL DEPLOYMENT BLOCKER — Architecture B Live Worker Replacement Risk (`auto-reply-bot`):**
> Because Cloudflare Workers Builds injects `WRANGLER_CI_OVERRIDE_NAME=auto-reply-bot` and runs bare `wrangler deploy`, a root deployment from this repository targets the existing live Cloudflare Worker **`auto-reply-bot`** (`https://auto-reply-bot.zentrymodernization.workers.dev`, currently receiving 100% live traffic at v7) with top-level `"ENVIRONMENT": "staging"` and staging D1/Queue bindings.
> - **Architecture B CANNOT stage safely without replacing or disrupting the currently deployed `auto-reply-bot` Worker.**
> - Before any deployment is executed, the Owner must explicitly choose between:
>   1. **Alternative 1 (Authorized Temporary Replacement of `auto-reply-bot`):** Explicitly authorize replacing the live `auto-reply-bot` Worker with staging configuration (`acknowledgeLiveWorkerReplacementRisk: true` + `explicitOwnerAuthorization: true`), accepting service impact on whatever `auto-reply-bot` v7 currently serves.
>   2. **Alternative 2 (Dedicated Separate Staging Worker Identity):** Provision and target a separate dedicated staging Worker service (e.g., `vip-gaming-bot-staging` or `auto-reply-bot-staging` via `npx wrangler deploy --env staging` without `WRANGLER_CI_OVERRIDE_NAME=auto-reply-bot`), leaving the existing live `auto-reply-bot` Worker untouched.

---

## Phase 3.3 5-State Deployment Readiness Gate (`src/worker/lib/deploymentGuard.ts`)

`validateWranglerDeploymentConfig` and `enforceDeploymentGate` enforce five distinct fail-closed readiness states:
1. **`localConfigValid`:** Static local verification of `wrangler.jsonc` and `.env.example` (top-level `"keep_vars": true`, zero `keep_vars` in named environments, 10 static vars, 3 Dashboard-managed vars omitted from `vars`, 4 required secrets + 2 optional rotation secrets omitted from `vars`, all 3 cron schedules `["* * * * *", "*/5 * * * *", "0 20 * * *"]` across top-level/staging/production, `max_retries: 3` on primary queue consumers and `max_retries: 0` on DLQ consumers, and zero root vs. `env.staging` Worker name collision).
2. **`stagingResourceReady`:** Real non-placeholder staging D1 UUID synchronized across top-level and `env.staging`, isolated from production D1/Queues, AND explicit external verification that staging D1 (`vip-gaming-d1-staging`) and staging Queues (`vip-outbox-queue-staging`, `vip-outbox-dlq-staging`) exist and have migrations `0001`–`0005` applied.
3. **`secretConfigReady`:** Zero secret names in `wrangler.jsonc` `vars` or historical Dashboard plaintext bindings, AND explicit external verification that all 4 required Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `WITHDRAWAL_PII_ENCRYPTION_KEY`) are stored as Cloudflare Encrypted Secrets (`secret_text`).
4. **`adminNotificationReady`:** Explicit external verification that Dashboard-managed variables (`TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_GROUP_ID`, `SUPER_ADMIN_IDS`) are configured and at least one active `SUPER_ADMIN` has initialized a private DM with the bot (`/start` -> `has_started_bot = 1`).
5. **`deploymentAuthorized`:** Explicit per-invocation Owner authorization (`explicitOwnerAuthorization === true`) AND explicit acknowledgment of the live Worker replacement risk (`acknowledgeLiveWorkerReplacementRisk === true`) when targeting `auto-reply-bot` in `temporary_staging` mode.

> **Important Scope Boundary:** Local TypeScript deployment guards (`deploymentGuard.ts`) and local test suites are **advisory repository checks only** (`LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK`). They **cannot** inspect remote Cloudflare Dashboard state and **cannot** automatically prevent a remote Cloudflare Workers Builds pipeline from running `npx wrangler deploy` unless the Owner configures the remote Cloudflare Workers Builds **Build Command** to execute `npm run lint && npm test && npm run build:worker` before deployment.

---

## Pre-Deployment Security & Historical Plaintext Credential Audit Checklist

Before any separately authorized Cloudflare deployment:

1. **Resolve the Live Worker vs. Staging Identity Blocker:**
   - Decide between **Alternative 1** (explicitly authorized temporary replacement of `auto-reply-bot` with acknowledged live traffic impact) or **Alternative 2** (dedicated staging Worker service).
2. **Inspect & Remove Historical Plaintext Credential Bindings (Critical with `"keep_vars": true`):**
   - `"keep_vars": true` instructs Cloudflare to preserve existing Dashboard plaintext (`plain_text` / `json`) variables across deployments and **does not** automatically convert plaintext variables into encrypted Secrets (`secret_text`).
   - In **Cloudflare Dashboard -> Workers & Pages -> `auto-reply-bot` -> Settings -> Variables and Secrets**, inspect all existing bindings.
   - If `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, or `WITHDRAWAL_PII_ENCRYPTION_KEY` exist as **Plaintext (`Text`)** bindings from earlier deployments, **delete those plaintext bindings first** and recreate them strictly as **Encrypted Secrets** (`wrangler secret put <NAME>` or Dashboard **Secret** type).
   - **Encryption Key Caution:** Do **not** rotate `WITHDRAWAL_PII_ENCRYPTION_KEY` without first verifying whether historical non-redacted withdrawal ciphertexts exist in D1 and preparing a dual-key (`WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS` + incremented `ENCRYPTION_KEY_VERSION`) migration plan.
3. **Verify Dashboard-Managed Plaintext Variables (`Strategy 1`) & Super Admin `/start` Onboarding:**
   - Ensure only the 3 non-secret dynamic routing variables (`TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_GROUP_ID`, `SUPER_ADMIN_IDS`) are stored as Dashboard Plaintext Variables, pointing to staging-dedicated Telegram bot/group resources.
   - Ensure at least one `SUPER_ADMIN` sends `/start` to the staging bot in private chat (`has_started_bot = 1`). If `TELEGRAM_ADMIN_GROUP_ID` is unconfigured/unreachable and no `SUPER_ADMIN` has started the bot yet, the outbox consumer holds admin alerts in `RETRYABLE_FAILURE` (`ADMIN_NOTIFICATION_HELD_NO_REACHABLE_ADMIN`) and automatically releases them as soon as a `SUPER_ADMIN` runs `/start` or `TELEGRAM_ADMIN_GROUP_ID` is configured.
4. **Cloudflare Workers Builds Pipeline Gate:**
   - Configure the Cloudflare Workers Builds **Build Command** to execute:
     ```bash
     npm run lint && npm test && npm run build:worker
     ```
     before the **Deploy Command** (`npx wrangler deploy`) so that any test or deployment-guard failure aborts the build before Wrangler runs.

---

## Local Verification Commands

```bash
# TypeScript static analysis
npm run lint

# Production ESM Worker bundle verification
npm run build:worker

# Full unit, deployment guard, remediation (F-03, F-06, F-07), and real workerd + Miniflare D1 test suite
npm test
```
