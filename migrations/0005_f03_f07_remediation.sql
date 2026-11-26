-- 7777club VIP Gaming Telegram AI Support & Manual Deposit/Withdrawal System
-- Migration 0005: Deterministic Financial Ticket Association (F-03) & Versioned Audit Hash Integrity (F-07)
--
-- Forward-safe additive migration:
-- 1. Adds nullable target_ticket_id to customer_sessions so Deposit/Withdrawal workflows
--    persist their explicitly bound ticket ID from initialization through confirmation.
-- 2. Adds hash_version (DEFAULT 1) to audit_logs and audit_retention_checkpoints.
--    SQLite/D1 ALTER TABLE ADD COLUMN with constant DEFAULT updates schema metadata without
--    mutating historical rows or firing BEFORE UPDATE immutability triggers.
--    Pre-existing rows automatically classify as hash_version = 1 (legacy verifier);
--    all newly written rows explicitly persist hash_version = 2 (canonical full-field verifier).

ALTER TABLE customer_sessions
  ADD COLUMN target_ticket_id TEXT NULL DEFAULT NULL REFERENCES support_tickets(ticket_id) ON DELETE SET NULL;

ALTER TABLE audit_logs
  ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version >= 1);

ALTER TABLE audit_retention_checkpoints
  ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version >= 1);
