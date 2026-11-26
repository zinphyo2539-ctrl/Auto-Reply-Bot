-- 7777club VIP Gaming Telegram AI Support & Manual Deposit/Withdrawal System
-- Migration 0001: Complete 17-Table Relational Schema (Cloudflare D1 / SQLite)

PRAGMA foreign_keys = ON;

-- 1. customers
CREATE TABLE IF NOT EXISTS customers (
  telegram_user_id TEXT NOT NULL PRIMARY KEY CHECK (telegram_user_id GLOB '[0-9]*' AND length(telegram_user_id) BETWEEN 1 AND 20),
  username TEXT NULL DEFAULT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  language_code TEXT NOT NULL DEFAULT 'my' CHECK (language_code IN ('my', 'en')),
  chat_mode TEXT NOT NULL DEFAULT 'AI' CHECK (chat_mode IN ('AI', 'HUMAN')),
  account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'BANNED')),
  mode_changed_at INTEGER NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_preview TEXT NULL DEFAULT NULL,
  last_interaction_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. admins
CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id TEXT NOT NULL PRIMARY KEY CHECK (telegram_user_id GLOB '[0-9]*' AND length(telegram_user_id) BETWEEN 1 AND 20),
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'SUPPORT_AGENT')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  has_started_bot INTEGER NOT NULL DEFAULT 0 CHECK (has_started_bot IN (0, 1)),
  permissions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions_json) = 1),
  display_name TEXT NOT NULL,
  last_seen_at INTEGER NULL DEFAULT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3. support_tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id TEXT NOT NULL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(telegram_user_id) ON DELETE RESTRICT,
  ticket_type TEXT NOT NULL CHECK (ticket_type IN ('GENERAL_SUPPORT', 'SLIP_DEPOSIT', 'WITHDRAWAL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'ASSIGNED', 'RESOLVED')),
  assigned_admin_id TEXT NULL DEFAULT NULL REFERENCES admins(telegram_user_id) ON DELETE RESTRICT,
  resolved_by_admin_id TEXT NULL DEFAULT NULL REFERENCES admins(telegram_user_id) ON DELETE RESTRICT,
  group_notification_msg_id INTEGER NULL DEFAULT NULL,
  assigned_at INTEGER NULL DEFAULT NULL,
  last_admin_activity_at INTEGER NULL DEFAULT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sent IN (0, 1)),
  escalated INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),
  slip_count INTEGER NOT NULL DEFAULT 0 CHECK (slip_count >= 0),
  latest_slip_id TEXT NULL DEFAULT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  resolved_at INTEGER NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'OPEN' AND assigned_admin_id IS NULL) OR
    (status = 'ASSIGNED' AND assigned_admin_id IS NOT NULL) OR
    (status = 'RESOLVED')
  )
);

-- 4. messages
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT NOT NULL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(telegram_user_id) ON DELETE CASCADE,
  telegram_message_id INTEGER NULL DEFAULT NULL,
  update_id INTEGER NULL DEFAULT NULL,
  ticket_id TEXT NULL DEFAULT NULL REFERENCES support_tickets(ticket_id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('USER', 'MODEL', 'ADMIN', 'SYSTEM')),
  sender_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('TEXT', 'PHOTO', 'SYSTEM')),
  text_content TEXT NULL DEFAULT NULL,
  media_file_id TEXT NULL DEFAULT NULL,
  media_file_unique_id TEXT NULL DEFAULT NULL,
  is_potential_slip INTEGER NOT NULL DEFAULT 0 CHECK (is_potential_slip IN (0, 1)),
  include_in_ai_context INTEGER NOT NULL DEFAULT 0 CHECK (include_in_ai_context IN (0, 1)),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('RECEIVED', 'PENDING', 'SENT', 'DELIVERY_UNCERTAIN', 'PERMANENT_FAILURE')),
  created_at INTEGER NOT NULL
);

-- 5. slip_fingerprints
CREATE TABLE IF NOT EXISTS slip_fingerprints (
  file_unique_id TEXT NOT NULL PRIMARY KEY,
  first_customer_id TEXT NOT NULL,
  first_slip_id TEXT NOT NULL,
  first_ticket_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  last_customer_id TEXT NOT NULL,
  last_slip_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- 6. slip_reviews
CREATE TABLE IF NOT EXISTS slip_reviews (
  slip_id TEXT NOT NULL PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(ticket_id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(telegram_user_id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL REFERENCES slip_fingerprints(file_unique_id) ON DELETE RESTRICT,
  is_duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate_warning IN (0, 1)),
  duplicate_context_json TEXT NULL DEFAULT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('RECEIVED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_INFO')),
  reviewed_by_admin_id TEXT NULL DEFAULT NULL REFERENCES admins(telegram_user_id) ON DELETE RESTRICT,
  review_note TEXT NULL DEFAULT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER NULL DEFAULT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (review_status IN ('REJECTED', 'NEEDS_INFO') AND review_note IS NOT NULL AND length(trim(review_note)) > 0) OR
    (review_status IN ('RECEIVED', 'UNDER_REVIEW', 'APPROVED'))
  )
);

-- 7. deposit_requests (Phase 2 v3.0.3 Structured Manual Deposit Intake & Review)
CREATE TABLE IF NOT EXISTS deposit_requests (
  deposit_id TEXT NOT NULL PRIMARY KEY,
  idempotency_token TEXT NOT NULL UNIQUE,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(ticket_id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(telegram_user_id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'MMK',
  method_code TEXT NOT NULL,
  customer_reference_text TEXT NULL DEFAULT NULL,
  slip_id TEXT NULL DEFAULT NULL REFERENCES slip_reviews(slip_id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO', 'APPROVED_MANUAL_CREDITED', 'REJECTED', 'CANCELLED_BY_CUSTOMER')),
  reviewed_by_admin_id TEXT NULL DEFAULT NULL REFERENCES admins(telegram_user_id) ON DELETE RESTRICT,
  decision_note TEXT NULL DEFAULT NULL,
  admin_operation_evidence_ref TEXT NULL DEFAULT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER NULL DEFAULT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status IN ('REJECTED', 'NEEDS_INFO') AND decision_note IS NOT NULL AND length(trim(decision_note)) > 0) OR
    (status NOT IN ('REJECTED', 'NEEDS_INFO'))
  ),
  CHECK (
    (status = 'APPROVED_MANUAL_CREDITED' AND admin_operation_evidence_ref IS NOT NULL AND length(trim(admin_operation_evidence_ref)) > 0) OR
    (status != 'APPROVED_MANUAL_CREDITED')
  )
);

-- 8. withdrawal_requests (Phase 2 v3.0.3 Manual Withdrawal Intake & Review with AES-256-GCM Destination Encryption)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  withdrawal_id TEXT NOT NULL PRIMARY KEY,
  idempotency_token TEXT NOT NULL UNIQUE,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(ticket_id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(telegram_user_id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'MMK',
  method_code TEXT NOT NULL,
  destination_masked TEXT NOT NULL,
  destination_ciphertext TEXT NOT NULL,
  destination_iv TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFO', 'APPROVED_FOR_PAYOUT', 'PAID_RECORDED', 'REJECTED', 'CANCELLED_BY_CUSTOMER')),
  reviewed_by_admin_id TEXT NULL DEFAULT NULL REFERENCES admins(telegram_user_id) ON DELETE RESTRICT,
  decision_note TEXT NULL DEFAULT NULL,
  payment_evidence_ref TEXT NULL DEFAULT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER NULL DEFAULT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status IN ('REJECTED', 'NEEDS_INFO') AND decision_note IS NOT NULL AND length(trim(decision_note)) > 0) OR
    (status NOT IN ('REJECTED', 'NEEDS_INFO'))
  ),
  CHECK (
    (status = 'PAID_RECORDED' AND payment_evidence_ref IS NOT NULL AND length(trim(payment_evidence_ref)) > 0) OR
    (status != 'PAID_RECORDED')
  )
);

-- 9. customer_sessions (Versioned Wizard Concurrency & Fixed Expiry for Deposit/Withdrawal Intake & NEEDS_INFO Replies)
CREATE TABLE IF NOT EXISTS customer_sessions (
  customer_id TEXT NOT NULL PRIMARY KEY REFERENCES customers(telegram_user_id) ON DELETE CASCADE,
  wizard_type TEXT NOT NULL CHECK (wizard_type IN ('NONE', 'DEPOSIT', 'WITHDRAWAL', 'NEEDS_INFO_REPLY')),
  wizard_state TEXT NOT NULL CHECK (wizard_state IN (
    'IDLE',
    'DEP_AWAITING_AMOUNT', 'DEP_AWAITING_METHOD', 'DEP_AWAITING_REFERENCE', 'DEP_AWAITING_CONFIRM',
    'WD_AWAITING_AMOUNT', 'WD_AWAITING_METHOD', 'WD_AWAITING_DESTINATION', 'WD_AWAITING_CONFIRM',
    'AWAITING_CUSTOMER_INFO_REPLY'
  )),
  draft_token TEXT NOT NULL,
  draft_amount INTEGER NULL DEFAULT NULL CHECK (draft_amount IS NULL OR draft_amount > 0),
  draft_method_code TEXT NULL DEFAULT NULL,
  draft_reference_text TEXT NULL DEFAULT NULL,
  draft_dest_masked TEXT NULL DEFAULT NULL,
  draft_dest_ciphertext TEXT NULL DEFAULT NULL,
  draft_dest_iv TEXT NULL DEFAULT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  target_request_type TEXT NULL DEFAULT NULL CHECK (target_request_type IS NULL OR target_request_type IN ('DEPOSIT', 'WITHDRAWAL', 'SLIP')),
  target_request_id TEXT NULL DEFAULT NULL,
  wizard_version INTEGER NOT NULL DEFAULT 1 CHECK (wizard_version >= 1),
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 10. outbox (7-State Machine with CLAIMED vs SENDING Separation)
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('CUSTOMER', 'TICKET', 'SLIP', 'DEPOSIT', 'WITHDRAWAL', 'ADMIN', 'SYSTEM')),
  aggregate_id TEXT NOT NULL,
  target_chat_id TEXT NOT NULL,
  ordering_key TEXT NOT NULL,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  telegram_method TEXT NOT NULL CHECK (telegram_method IN ('sendMessage', 'sendPhoto', 'editMessageText')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
  is_idempotent_method INTEGER NOT NULL DEFAULT 0 CHECK (is_idempotent_method IN (0, 1)),
  related_message_id TEXT NULL DEFAULT NULL,
  related_ticket_id TEXT NULL DEFAULT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'SENDING', 'SENT', 'RETRYABLE_FAILURE', 'DELIVERY_UNCERTAIN', 'PERMANENT_FAILURE')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 6 CHECK (max_attempts >= 1),
  available_at INTEGER NOT NULL,
  next_dispatch_at INTEGER NOT NULL,
  lease_owner TEXT NULL DEFAULT NULL,
  lease_token TEXT NULL DEFAULT NULL,
  lease_expires_at INTEGER NULL DEFAULT NULL,
  telegram_message_id INTEGER NULL DEFAULT NULL,
  last_error TEXT NULL DEFAULT NULL,
  delivery_uncertain_at INTEGER NULL DEFAULT NULL,
  sent_at INTEGER NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 11. processed_updates
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER NOT NULL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  lease_owner TEXT NULL DEFAULT NULL,
  lease_expires_at INTEGER NULL DEFAULT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error TEXT NULL DEFAULT NULL,
  received_at INTEGER NOT NULL,
  processing_started_at INTEGER NOT NULL,
  completed_at INTEGER NULL DEFAULT NULL,
  expires_at INTEGER NOT NULL
);

-- 12. processed_queue_events
CREATE TABLE IF NOT EXISTS processed_queue_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  consumer_lease_token TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('IN_PROGRESS', 'COMPLETED', 'ABORTED')),
  processed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 13. admin_sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_id TEXT NOT NULL PRIMARY KEY REFERENCES admins(telegram_user_id) ON DELETE CASCADE,
  session_state TEXT NOT NULL CHECK (session_state IN (
    'IDLE', 'REPLYING_TO_CUSTOMER', 'AWAITING_SLIP_NOTE',
    'AWAITING_DEPOSIT_NOTE', 'AWAITING_DEPOSIT_EVIDENCE',
    'AWAITING_WITHDRAWAL_NOTE', 'AWAITING_WITHDRAWAL_EVIDENCE',
    'AWAITING_CUSTOMER_SEARCH', 'EDITING_FAQ', 'EDITING_PROMPT', 'EDITING_WELCOME'
  )),
  target_customer_id TEXT NULL DEFAULT NULL,
  target_ticket_id TEXT NULL DEFAULT NULL,
  target_slip_id TEXT NULL DEFAULT NULL,
  target_deposit_id TEXT NULL DEFAULT NULL,
  target_withdrawal_id TEXT NULL DEFAULT NULL,
  pending_decision TEXT NULL DEFAULT NULL,
  target_expected_version INTEGER NULL DEFAULT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 14. faq_entries
CREATE TABLE IF NOT EXISTS faq_entries (
  faq_id TEXT NOT NULL PRIMARY KEY,
  question_my TEXT NOT NULL CHECK (length(trim(question_my)) BETWEEN 1 AND 300),
  answer_my TEXT NOT NULL CHECK (length(trim(answer_my)) BETWEEN 1 AND 3500),
  question_en TEXT NOT NULL CHECK (length(trim(question_en)) BETWEEN 1 AND 300),
  answer_en TEXT NOT NULL CHECK (length(trim(answer_en)) BETWEEN 1 AND 3500),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  updated_by_admin_id TEXT NOT NULL,
  last_mutation_token TEXT NULL DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 15. config (Singleton Active Runtime Configuration)
CREATE TABLE IF NOT EXISTS config (
  config_id TEXT NOT NULL PRIMARY KEY CHECK (config_id = 'active'),
  active_version INTEGER NOT NULL DEFAULT 1 CHECK (active_version >= 1),
  ai_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ai_enabled IN (0, 1)),
  welcome_text_my TEXT NOT NULL,
  welcome_text_en TEXT NOT NULL,
  welcome_image_file_id TEXT NULL DEFAULT NULL,
  system_prompt TEXT NOT NULL,
  menu_buttons_json TEXT NOT NULL CHECK (json_valid(menu_buttons_json) = 1),
  payment_methods_json TEXT NOT NULL CHECK (json_valid(payment_methods_json) = 1),
  min_deposit_amount INTEGER NOT NULL DEFAULT 1000 CHECK (min_deposit_amount > 0),
  max_deposit_amount INTEGER NOT NULL DEFAULT 10000000 CHECK (max_deposit_amount >= min_deposit_amount),
  min_withdrawal_amount INTEGER NOT NULL DEFAULT 5000 CHECK (min_withdrawal_amount > 0),
  max_withdrawal_amount INTEGER NOT NULL DEFAULT 10000000 CHECK (max_withdrawal_amount >= min_withdrawal_amount),
  currency TEXT NOT NULL DEFAULT 'MMK',
  reminder_minutes INTEGER NOT NULL DEFAULT 30 CHECK (reminder_minutes BETWEEN 5 AND 240),
  escalation_minutes INTEGER NOT NULL DEFAULT 60 CHECK (escalation_minutes > reminder_minutes),
  updated_by_admin_id TEXT NOT NULL,
  last_mutation_token TEXT NULL DEFAULT NULL,
  updated_at INTEGER NOT NULL
);

-- 16. config_versions
CREATE TABLE IF NOT EXISTS config_versions (
  version_number INTEGER NOT NULL PRIMARY KEY CHECK (version_number >= 1),
  ai_enabled INTEGER NOT NULL CHECK (ai_enabled IN (0, 1)),
  welcome_text_my TEXT NOT NULL,
  welcome_text_en TEXT NOT NULL,
  welcome_image_file_id TEXT NULL DEFAULT NULL,
  system_prompt TEXT NOT NULL,
  menu_buttons_json TEXT NOT NULL,
  payment_methods_json TEXT NOT NULL,
  faq_snapshot_json TEXT NOT NULL,
  min_deposit_amount INTEGER NOT NULL,
  max_deposit_amount INTEGER NOT NULL,
  min_withdrawal_amount INTEGER NOT NULL,
  max_withdrawal_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reminder_minutes INTEGER NOT NULL,
  escalation_minutes INTEGER NOT NULL,
  rollback_from_version INTEGER NULL DEFAULT NULL,
  published_by_admin_id TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

-- 17. audit_logs (Append-Only Immutable Audit Trail)
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('SUPER_ADMIN', 'SUPPORT_AGENT', 'CUSTOMER', 'SYSTEM', 'UNAUTHORIZED')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('TICKET', 'SLIP', 'DEPOSIT', 'WITHDRAWAL', 'CUSTOMER', 'ADMIN', 'CONFIG', 'FAQ', 'OUTBOX', 'SYSTEM')),
  resource_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'CONFLICT', 'FAILURE')),
  before_state_json TEXT NULL DEFAULT NULL,
  after_state_json TEXT NULL DEFAULT NULL,
  reason TEXT NULL DEFAULT NULL,
  correlation_id TEXT NOT NULL,
  source_update_id INTEGER NULL DEFAULT NULL,
  prev_entry_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Immutability Triggers on audit_logs
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_LOGS_IMMUTABLE: UPDATE operations are forbidden on audit_logs');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_recent_delete
BEFORE DELETE ON audit_logs
WHEN OLD.created_at > ((strftime('%s','now') * 1000) - (300 * 86400000))
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_LOGS_IMMUTABLE: Cannot delete audit logs younger than retention floor');
END;
