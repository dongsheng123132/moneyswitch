-- v0.2 (SPEC-v0.2.md §1, §2): channels table, MoneyKey.allowed_models,
-- payments.kind/model/prompt_tokens/completion_tokens.

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);

ALTER TABLE money_keys ADD COLUMN allowed_models TEXT;

ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'fetch';
ALTER TABLE payments ADD COLUMN model TEXT;
ALTER TABLE payments ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE payments ADD COLUMN completion_tokens INTEGER;
