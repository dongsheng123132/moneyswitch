-- v0.4 (SPEC-v0.4.md §A): child MoneyKeys / multi-level delegation.
--
-- Additive only, so it upgrades an existing database in place: every
-- pre-existing key becomes a root key (parent_id NULL, depth 0,
-- can_delegate 0, created_by 'admin'), i.e. exactly its old behaviour.
-- (The migration runner wraps each file in one transaction.)

ALTER TABLE money_keys ADD COLUMN parent_id TEXT REFERENCES money_keys(id);
ALTER TABLE money_keys ADD COLUMN depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0);
ALTER TABLE money_keys ADD COLUMN can_delegate INTEGER NOT NULL DEFAULT 0 CHECK (can_delegate IN (0, 1));
ALTER TABLE money_keys ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin';

CREATE INDEX IF NOT EXISTS idx_money_keys_parent_id ON money_keys(parent_id);

-- Subtree spend sums filter payments by (key_id, status, created_at).
CREATE INDEX IF NOT EXISTS idx_payments_key_status_created ON payments(key_id, status, created_at);
