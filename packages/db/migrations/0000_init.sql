CREATE TABLE IF NOT EXISTS money_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  total_budget INTEGER NOT NULL,
  daily_budget INTEGER NOT NULL,
  per_request_limit INTEGER NOT NULL,
  approval_threshold INTEGER,
  allowed_hosts TEXT NOT NULL,
  max_payments_per_minute INTEGER NOT NULL DEFAULT 10,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_money_keys_prefix ON money_keys(key_prefix);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error_code TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_key_id ON payments(key_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_key_id ON approvals(key_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS admin_auth (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_meta (
  id TEXT PRIMARY KEY,
  address TEXT,
  created_at TEXT NOT NULL
);
