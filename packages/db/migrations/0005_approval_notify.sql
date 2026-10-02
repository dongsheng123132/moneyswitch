-- Approval push notifications: a transactional outbox on the approvals table
-- plus a small settings table for the notification channels.
--
-- When a payment needs human approval the operator gets a message (Feishu /
-- WeCom / Telegram / generic webhook) right away instead of having to open
-- the Approvals page. A background loop picks pending approvals whose
-- notified_at is still NULL, sends one message each and stamps notified_at.
-- It never sits on the payment path.
--
-- Additive only, so it upgrades an existing database in place: every
-- pre-existing approval keeps notified_at NULL / notify_attempts 0, and the
-- loop only ever looks at rows that are still `pending` and unexpired, so old
-- history is never re-sent. (The migration runner wraps this file in one
-- transaction.)

-- Set once a message was delivered to at least one channel.
ALTER TABLE approvals ADD COLUMN notified_at TEXT;
-- Delivery attempts claimed so far (bounded retries) and when the last one
-- started (retry back-off / lease so two loops never send the same attempt).
ALTER TABLE approvals ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN notify_attempt_at TEXT;

-- The outbox scan: pending approvals nobody has been told about yet.
CREATE INDEX IF NOT EXISTS idx_approvals_notify_outbox
  ON approvals(created_at)
  WHERE status = 'pending' AND notified_at IS NULL;

-- Admin-editable channel configuration (key/value). Environment variables
-- (MONEYSWITCH_NOTIFY_*) override these at read time and are never stored here.
CREATE TABLE IF NOT EXISTS notify_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
