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

## Worker Metadata & Architecture (Phase 6.3 — Zero-Root-Binding + Isolated Staging Architecture)

| Property | Value |
| :--- | :--- |
| **Root Worker Name (Protected Base Identity)** | `auto-reply-bot` (Zero root resource bindings; root deployment blocked by `build.command` pre-deploy guard) |
| **Staging Worker Target (`--env staging`)** | `auto-reply-bot-staging` (`ENVIRONMENT = "staging"`) |
| **Reserved Production Target (`--env production`)** | `auto-reply-bot-production` (`ENVIRONMENT = "production"`, disabled & unprovisioned) |
| **Dashboard Variable Persistence** | `"keep_vars": true` (Top-level only) |
| **Dashboard-Managed Variables** | `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_GROUP_ID`, `SUPER_ADMIN_IDS` (Omitted from `wrangler.jsonc` `vars` blocks; scoped per Worker service) |
| **Required Secrets (`secret_text`)** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `WITHDRAWAL_PII_ENCRYPTION_KEY` |
| **Optional Rotation Secrets** | `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`, `WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS` |
| **Entry Point** | `src/worker/index.ts` |
| **Runtime Compatibility** | `compatibility_date = "2025-03-01"`, `compatibility_flags = ["nodejs_compat"]` |
| **HTTP Router** | Hono (`GET /healthz`, `POST /webhook`) |
| **Staging D1 Database Binding (`env.staging`)** | `DB` -> `vip-gaming-d1-staging` (`bf4ea8f0-9212-4028-bc3b-00f274d44413`, migrations in `./migrations`) |
| **Staging Queue Bindings (`env.staging`)** | `OUTBOX_QUEUE` -> `vip-outbox-queue-staging`, DLQ `vip-outbox-dlq-staging` |
| **Cron Triggers (`env.staging` & `env.production`)** | `* * * * *` (Outbox lease recovery), `*/5 * * * *` (SLA reminder & escalation), `0 20 * * *` (02:30 MMT daily retention & PII redaction) |

---

## Phase 6.3 Dual-Layer Pre-Deploy Guard (`scripts/predeploy-check.ts` & `src/worker/lib/deploymentGuard.ts`)

1. **Zero-Root-Binding Protection (`ROOT_RESOURCE_BINDINGS_FORBIDDEN` & `ROOT_DEPLOYMENT_FORBIDDEN`):**
   - The root scope of `wrangler.jsonc` retains `"name": "auto-reply-bot"` and `"keep_vars": true` (so `--env staging` resolves to `"auto-reply-bot-staging"`), but declares **zero** `d1_databases`, **zero** `queues`, **zero** `vars`, and **zero** `triggers`.
   - Any bare `npx wrangler deploy` invokes top-level `build.command` (`npx tsx scripts/predeploy-check.ts --target=top-level`) and aborts with exit code `1` before Wrangler can authenticate, provision resources, or touch the existing `auto-reply-bot` (`v7`) Worker.
2. **Staging Isolation & CI Override Protection (`CI_OVERRIDE_NAME_MISMATCH`):**
   - `env.staging` (`auto-reply-bot-staging`) exclusively binds `vip-gaming-d1-staging` (`bf4ea8f0-9212-4028-bc3b-00f274d44413`), `vip-outbox-queue-staging`, and `vip-outbox-dlq-staging`.
   - Both `npm run predeploy:staging` and `env.staging.build.command` (`npx tsx scripts/predeploy-check.ts --target=staging`) verify that `WRANGLER_CI_OVERRIDE_NAME` is either unset or `"auto-reply-bot-staging"`. If `WRANGLER_CI_OVERRIDE_NAME="auto-reply-bot"` is injected by a misconnected CI pipeline, the pre-deploy hook aborts with exit code `1` before Wrangler `4.168.0` can override the target Worker name.
3. **Production Fail-Closed Lock (`PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE`):**
   - `env.production` (`auto-reply-bot-production`) remains disabled with placeholder D1 UUID `00000000-0000-0000-0000-000000000000` and is blocked by `env.production.build.command` (`npx tsx scripts/predeploy-check.ts --target=production`).

---

## Local Verification Commands

```bash
# TypeScript static analysis
npm run lint

# Production ESM Worker bundle verification
npm run build:worker

# Full unit, deployment guard, remediation (F-03, F-06, F-07), and real workerd + Miniflare D1 test suite (58 tests)
npm test

# Non-deploying staging dry-run (executes pre-deploy guard + wrangler deploy --env staging --no-x-provision --dry-run)
npm run deploy:staging:dry-run
```
