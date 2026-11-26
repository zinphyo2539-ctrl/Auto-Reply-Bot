-- 7777club VIP Gaming Telegram AI Support & Manual Deposit/Withdrawal System
-- Migration 0002: Query-Backed Single, Composite, and Partial Unique Indexes

-- 1. Enforce at most ONE active (OPEN or ASSIGNED) support ticket per customer at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_ticket_per_customer
  ON support_tickets (customer_id)
  WHERE status IN ('OPEN', 'ASSIGNED');

-- 2. Customer Inbox Filtering
CREATE INDEX IF NOT EXISTS idx_customers_inbox
  ON customers (chat_mode, account_status, last_interaction_at DESC);

-- 3. Strict Customer-Isolated AI Context Query (Latest 15 eligible messages for 1 customer)
CREATE INDEX IF NOT EXISTS idx_messages_ai_context
  ON messages (customer_id, include_in_ai_context, created_at DESC);

-- 4. Customer Paginated Message History & Retention Cleanup
CREATE INDEX IF NOT EXISTS idx_messages_customer_history
  ON messages (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_retention
  ON messages (created_at ASC);

-- 5. Ticket Queues: Unassigned OPEN Inbox & Admin's ASSIGNED Inbox
CREATE INDEX IF NOT EXISTS idx_tickets_status_created
  ON support_tickets (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_admin
  ON support_tickets (status, assigned_admin_id, updated_at DESC);

-- 6. Cron 30m Reminder & 60m Escalation Partial Indexes
CREATE INDEX IF NOT EXISTS idx_tickets_idle_reminder
  ON support_tickets (status, reminder_sent, last_admin_activity_at ASC)
  WHERE status = 'ASSIGNED' AND reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_tickets_idle_escalation
  ON support_tickets (status, escalated, last_admin_activity_at ASC)
  WHERE status = 'ASSIGNED' AND escalated = 0;

-- 7. Slip Reviews & Fingerprints
CREATE INDEX IF NOT EXISTS idx_slips_ticket
  ON slip_reviews (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slips_review_queue
  ON slip_reviews (review_status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_fingerprints_retention
  ON slip_fingerprints (last_seen_at ASC);

-- 8. Deposit Requests Indexes
CREATE INDEX IF NOT EXISTS idx_deposits_customer_created
  ON deposit_requests (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status_created
  ON deposit_requests (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_deposits_ticket
  ON deposit_requests (ticket_id, created_at DESC);

-- 9. Withdrawal Requests Indexes
CREATE INDEX IF NOT EXISTS idx_withdrawals_customer_created
  ON withdrawal_requests (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created
  ON withdrawal_requests (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_ticket
  ON withdrawal_requests (ticket_id, created_at DESC);

-- 10. Outbox Due Jobs, Ordering & Expired Lease Recovery
CREATE INDEX IF NOT EXISTS idx_outbox_due_jobs
  ON outbox (status, available_at ASC, next_dispatch_at ASC)
  WHERE status IN ('PENDING', 'RETRYABLE_FAILURE');

CREATE INDEX IF NOT EXISTS idx_outbox_expired_leases
  ON outbox (status, lease_expires_at ASC)
  WHERE status IN ('CLAIMED', 'SENDING');

CREATE INDEX IF NOT EXISTS idx_outbox_ordering
  ON outbox (ordering_key, created_at ASC, sequence_no ASC)
  WHERE status IN ('PENDING', 'CLAIMED', 'SENDING', 'RETRYABLE_FAILURE');

-- 11. Processed Updates & Queue Events
CREATE INDEX IF NOT EXISTS idx_updates_expired_leases
  ON processed_updates (status, lease_expires_at ASC)
  WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS idx_updates_retention
  ON processed_updates (expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_queue_events_retention
  ON processed_queue_events (expires_at ASC);

-- 12. Audit Logs Resource History & Retention
CREATE INDEX IF NOT EXISTS idx_audit_resource
  ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_retention
  ON audit_logs (created_at ASC);
