-- Approval push notifications, per-channel delivery state.
--
-- 0005 tracked delivery per approval, so an approval that one channel took was
-- never retried on a channel that had failed. This table tracks every
-- (approval, channel) on its own: attempts + back-off, when it was delivered,
-- or why it was deliberately not sent (a repeat of a request that was already
-- announced, or the per-key flood cap). approvals.notified_at stays the
-- "outbox is done with this approval and at least one channel received it"
-- stamp; approvals.notify_attempts / notify_attempt_at from 0005 are no longer
-- written (additive-only migrations: the columns stay, nothing reads them).
--
-- Additive only: existing databases upgrade in place; rows appear lazily, the
-- first time the outbox looks at a pending approval. (The migration runner
-- wraps this file in one transaction.)

CREATE TABLE IF NOT EXISTS approval_notify_deliveries (
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  -- feishu | wecom | telegram | webhook
  channel TEXT NOT NULL,
  -- approval = the normal per-approval message; digest = the one summary sent
  -- when a key floods (see "skipped" for the silent rest)
  kind TEXT NOT NULL DEFAULT 'approval',
  -- delivery attempts claimed so far (bounded retries) and when the last one started
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_at TEXT,
  delivered_at TEXT,
  -- NULL, or why nothing is sent for this approval on this channel: duplicate | rate_limited
  skipped TEXT,
  -- when the outbox decided what to do with it (also the per-key flood window clock)
  created_at TEXT NOT NULL,
  PRIMARY KEY (approval_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_notify_deliveries_channel_created
  ON approval_notify_deliveries(channel, created_at);
