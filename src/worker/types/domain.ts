export type ChatMode = 'AI' | 'HUMAN';
export type AccountStatus = 'ACTIVE' | 'BANNED';
export type LanguageCode = 'my' | 'en';
export type AdminRole = 'SUPER_ADMIN' | 'SUPPORT_AGENT';
export type TicketType = 'GENERAL_SUPPORT' | 'SLIP_DEPOSIT' | 'WITHDRAWAL';
export type TicketStatus = 'OPEN' | 'ASSIGNED' | 'RESOLVED';
export type SlipReviewStatus = 'RECEIVED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';
export type DepositStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'NEEDS_INFO'
  | 'APPROVED_MANUAL_CREDITED'
  | 'REJECTED'
  | 'CANCELLED_BY_CUSTOMER';
export type WithdrawalStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'NEEDS_INFO'
  | 'APPROVED_FOR_PAYOUT'
  | 'PAID_RECORDED'
  | 'REJECTED'
  | 'CANCELLED_BY_CUSTOMER';
export type OutboxStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'SENDING'
  | 'SENT'
  | 'RETRYABLE_FAILURE'
  | 'DELIVERY_UNCERTAIN'
  | 'PERMANENT_FAILURE';

export interface CustomerRow {
  telegram_user_id: string;
  username: string | null;
  first_name: string;
  language_code: LanguageCode;
  chat_mode: ChatMode;
  account_status: AccountStatus;
  mode_changed_at: number;
  unread_count: number;
  last_message_preview: string | null;
  last_interaction_at: number;
  version: number;
  last_mutation_token: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminRow {
  telegram_user_id: string;
  role: AdminRole;
  is_active: number;
  has_started_bot: number;
  permissions_json: string;
  display_name: string;
  last_seen_at: number | null;
  version: number;
  last_mutation_token: string | null;
  created_at: number;
  updated_at: number;
}

export interface SupportTicketRow {
  ticket_id: string;
  customer_id: string;
  ticket_type: TicketType;
  status: TicketStatus;
  assigned_admin_id: string | null;
  resolved_by_admin_id: string | null;
  group_notification_msg_id: number | null;
  assigned_at: number | null;
  last_admin_activity_at: number | null;
  reminder_sent: number;
  escalated: number;
  slip_count: number;
  latest_slip_id: string | null;
  version: number;
  last_mutation_token: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  message_id: string;
  customer_id: string;
  telegram_message_id: number | null;
  update_id: number | null;
  ticket_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  sender_role: 'USER' | 'MODEL' | 'ADMIN' | 'SYSTEM';
  sender_id: string;
  message_type: 'TEXT' | 'PHOTO' | 'SYSTEM';
  text_content: string | null;
  media_file_id: string | null;
  media_file_unique_id: string | null;
  is_potential_slip: number;
  include_in_ai_context: number;
  delivery_status: 'RECEIVED' | 'PENDING' | 'SENT' | 'DELIVERY_UNCERTAIN' | 'PERMANENT_FAILURE';
  created_at: number;
}

export interface SlipFingerprintRow {
  file_unique_id: string;
  first_customer_id: string;
  first_slip_id: string;
  first_ticket_id: string;
  first_seen_at: number;
  occurrence_count: number;
  last_customer_id: string;
  last_slip_id: string;
  last_seen_at: number;
}

export interface SlipReviewRow {
  slip_id: string;
  ticket_id: string;
  customer_id: string;
  file_id: string;
  file_unique_id: string;
  is_duplicate_warning: number;
  duplicate_context_json: string | null;
  review_status: SlipReviewStatus;
  reviewed_by_admin_id: string | null;
  review_note: string | null;
  version: number;
  last_mutation_token: string | null;
  created_at: number;
  reviewed_at: number | null;
  updated_at: number;
}

export interface DepositRequestRow {
  deposit_id: string;
  idempotency_token: string;
  ticket_id: string;
  customer_id: string;
  amount: number;
  currency: string;
  method_code: string;
  customer_reference_text: string | null;
  slip_id: string | null;
  status: DepositStatus;
  reviewed_by_admin_id: string | null;
  decision_note: string | null;
  admin_operation_evidence_ref: string | null;
  version: number;
  last_mutation_token: string | null;
  created_at: number;
  reviewed_at: number | null;
  updated_at: number;
}

export interface WithdrawalRequestRow {
  withdrawal_id: string;
  idempotency_token: string;
  ticket_id: string;
  customer_id: string;
  amount: number;
  currency: string;
  method_code: string;
  destination_masked: string;
  destination_ciphertext: string;
  destination_iv: string;
  encryption_key_version: number;
  status: WithdrawalStatus;
  reviewed_by_admin_id: string | null;
  decision_note: string | null;
  payment_evidence_ref: string | null;
  version: number;
  last_mutation_token: string | null;
  created_at: number;
  reviewed_at: number | null;
  updated_at: number;
}

export interface CustomerSessionRow {
  customer_id: string;
  wizard_type: 'NONE' | 'DEPOSIT' | 'WITHDRAWAL' | 'NEEDS_INFO_REPLY';
  wizard_state:
    | 'IDLE'
    | 'DEP_AWAITING_AMOUNT'
    | 'DEP_AWAITING_METHOD'
    | 'DEP_AWAITING_REFERENCE'
    | 'DEP_AWAITING_CONFIRM'
    | 'WD_AWAITING_AMOUNT'
    | 'WD_AWAITING_METHOD'
    | 'WD_AWAITING_DESTINATION'
    | 'WD_AWAITING_CONFIRM'
    | 'AWAITING_CUSTOMER_INFO_REPLY';
  draft_token: string;
  draft_amount: number | null;
  draft_method_code: string | null;
  draft_reference_text: string | null;
  draft_dest_masked: string | null;
  draft_dest_ciphertext: string | null;
  draft_dest_iv: string | null;
  key_version: number;
  target_request_type: 'DEPOSIT' | 'WITHDRAWAL' | 'SLIP' | null;
  target_request_id: string | null;
  wizard_version: number;
  started_at: number;
  expires_at: number;
  updated_at: number;
}

export interface OutboxRow {
  outbox_id: string;
  idempotency_key: string;
  event_type: string;
  aggregate_type: 'CUSTOMER' | 'TICKET' | 'SLIP' | 'DEPOSIT' | 'WITHDRAWAL' | 'ADMIN' | 'SYSTEM';
  aggregate_id: string;
  target_chat_id: string;
  ordering_key: string;
  sequence_no: number;
  telegram_method: 'sendMessage' | 'sendPhoto' | 'editMessageText';
  payload_json: string;
  is_idempotent_method: number;
  related_message_id: string | null;
  related_ticket_id: string | null;
  status: OutboxStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: number;
  next_dispatch_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  telegram_message_id: number | null;
  last_error: string | null;
  delivery_uncertain_at: number | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AdminSessionRow {
  admin_id: string;
  session_state:
    | 'IDLE'
    | 'REPLYING_TO_CUSTOMER'
    | 'AWAITING_SLIP_NOTE'
    | 'AWAITING_DEPOSIT_NOTE'
    | 'AWAITING_DEPOSIT_EVIDENCE'
    | 'AWAITING_WITHDRAWAL_NOTE'
    | 'AWAITING_WITHDRAWAL_EVIDENCE'
    | 'AWAITING_CUSTOMER_SEARCH'
    | 'EDITING_FAQ'
    | 'EDITING_PROMPT'
    | 'EDITING_WELCOME';
  target_customer_id: string | null;
  target_ticket_id: string | null;
  target_slip_id: string | null;
  target_deposit_id: string | null;
  target_withdrawal_id: string | null;
  pending_decision: string | null;
  target_expected_version: number | null;
  expires_at: number;
  updated_at: number;
}

export interface PaymentMethodConfig {
  code: string;
  nameMy: string;
  nameEn: string;
  enabled: boolean;
  instructionsMy: string;
  instructionsEn: string;
}

export interface MenuButtonConfig {
  code: string;
  labelMy: string;
  labelEn: string;
}

export interface ConfigRow {
  config_id: 'active';
  active_version: number;
  ai_enabled: number;
  welcome_text_my: string;
  welcome_text_en: string;
  welcome_image_file_id: string | null;
  system_prompt: string;
  menu_buttons_json: string;
  payment_methods_json: string;
  min_deposit_amount: number;
  max_deposit_amount: number;
  min_withdrawal_amount: number;
  max_withdrawal_amount: number;
  currency: string;
  reminder_minutes: number;
  escalation_minutes: number;
  updated_by_admin_id: string;
  last_mutation_token: string | null;
  updated_at: number;
}

export interface FaqEntryRow {
  faq_id: string;
  question_my: string;
  answer_my: string;
  question_en: string;
  answer_en: string;
  display_order: number;
  is_enabled: number;
  updated_by_admin_id: string;
  last_mutation_token: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuditLogRow {
  audit_id: string;
  actor_id: string;
  actor_role: 'SUPER_ADMIN' | 'SUPPORT_AGENT' | 'CUSTOMER' | 'SYSTEM' | 'UNAUTHORIZED';
  action: string;
  resource_type: 'TICKET' | 'SLIP' | 'DEPOSIT' | 'WITHDRAWAL' | 'CUSTOMER' | 'ADMIN' | 'CONFIG' | 'FAQ' | 'OUTBOX' | 'SYSTEM';
  resource_id: string;
  result: 'SUCCESS' | 'DENIED' | 'CONFLICT' | 'FAILURE';
  before_state_json: string | null;
  after_state_json: string | null;
  reason: string | null;
  correlation_id: string;
  source_update_id: number | null;
  prev_entry_hash: string;
  entry_hash: string;
  created_at: number;
}

export interface AuditRetentionCheckpointRow {
  checkpoint_id: string;
  prev_checkpoint_hash: string;
  anchor_audit_id: string;
  anchor_entry_hash: string;
  anchor_created_at: number;
  purged_count: number;
  checkpoint_hash: string;
  created_at: number;
}
