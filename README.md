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

## Worker Metadata & Architecture

| Property | Value |
| :--- | :--- |
| **Worker Name** | `vip-gaming-bot` |
| **Cloudflare System Service Tag** | `cf:service=vip-gaming-bot` |
| **Entry Point** | `src/worker/index.ts` |
| **Runtime Compatibility** | `compatibility_date = "2025-03-01"`, `compatibility_flags = ["nodejs_compat"]` |
| **HTTP Router** | Hono (`GET /healthz`, `POST /webhook`) |
| **Primary Database Binding** | `DB` (Cloudflare D1, migrations in `./migrations`) |
| **Queue Producer Binding** | `OUTBOX_QUEUE` (Cloudflare Queues) |
| **Cron Triggers** | `* * * * *` (Outbox lease recovery), `*/5 * * * *` (SLA reminder & escalation), `0 20 * * *` (02:30 MMT daily retention & PII redaction) |

> **Note on Cloudflare Worker Description Metadata:** Wrangler's configuration schema (`node_modules/wrangler/config-schema.json`) does not support a `description` property in `wrangler.jsonc`. Cloudflare automatically assigns the system tag `cf:service=vip-gaming-bot` from `"name": "vip-gaming-bot"`. This `README.md` serves as the canonical repository project description.

---

## Local Verification Commands

```bash
# TypeScript static analysis
npm run lint

# Production ESM Worker bundle verification
npm run build:worker

# Full unit, remediation (F-03, F-06, F-07), and real workerd + Miniflare D1 test suite
npm test
```
