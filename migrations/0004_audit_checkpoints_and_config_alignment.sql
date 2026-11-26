-- 7777club VIP Gaming Telegram AI Support & Manual Deposit/Withdrawal System
-- Migration 0004: Audit Hash-Chain Serialization, Retention Checkpoints, Outbox Retention Index & Safe Bootstrap Alignment

-- 1. Enforce strictly linear, fork-free audit hash chain at the database engine level.
--    No two audit_logs entries may link to the same prev_entry_hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_unique_prev_hash
  ON audit_logs (prev_entry_hash);

-- 2. Append-only immutable audit retention checkpoints.
--    Preserves cryptographic continuity when audit_logs older than retention floor (>300d) are pruned.
CREATE TABLE IF NOT EXISTS audit_retention_checkpoints (
  checkpoint_id TEXT NOT NULL PRIMARY KEY,
  prev_checkpoint_hash TEXT NOT NULL UNIQUE,
  anchor_audit_id TEXT NOT NULL,
  anchor_entry_hash TEXT NOT NULL,
  anchor_created_at INTEGER NOT NULL,
  purged_count INTEGER NOT NULL CHECK (purged_count >= 1),
  checkpoint_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_audit_checkpoints_no_update
BEFORE UPDATE ON audit_retention_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_CHECKPOINTS_IMMUTABLE: UPDATE operations are forbidden on audit_retention_checkpoints');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_checkpoints_no_delete
BEFORE DELETE ON audit_retention_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_CHECKPOINTS_IMMUTABLE: DELETE operations are forbidden on audit_retention_checkpoints');
END;

-- 3. Bounded terminal outbox retention index (only SENT and PERMANENT_FAILURE may be pruned)
CREATE INDEX IF NOT EXISTS idx_outbox_terminal_retention
  ON outbox (status, updated_at ASC)
  WHERE status IN ('SENT', 'PERMANENT_FAILURE');

-- 4. Reconcile untouched bootstrap config to safe AI-disabled default (ai_enabled = 0)
--    until an authorized SUPER_ADMIN explicitly enables AI via /toggle_ai.
UPDATE config
SET ai_enabled = 0
WHERE config_id = 'active'
  AND active_version = 1
  AND updated_by_admin_id = 'SYSTEM_BOOTSTRAP';

-- 5. Align untouched bootstrap config_versions v1 with ai_enabled = 0 and actual seeded FAQ snapshot
UPDATE config_versions
SET ai_enabled = 0,
    faq_snapshot_json = COALESCE(
      (
        SELECT json_group_array(
          json_object(
            'faqId', faq_id,
            'questionMy', question_my,
            'questionEn', question_en,
            'displayOrder', display_order,
            'isEnabled', is_enabled
          )
        )
        FROM faq_entries
      ),
      '[]'
    )
WHERE version_number = 1
  AND published_by_admin_id = 'SYSTEM_BOOTSTRAP';
