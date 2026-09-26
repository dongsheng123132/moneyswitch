-- v0.5 (SPEC-v0.5.md §2): toll booths — sell any API to AI for USDC.
--
-- Additive only (three new tables, no change to existing ones), so it
-- upgrades a v0.4 database in place. The migration runner wraps this file
-- in one transaction.

CREATE TABLE IF NOT EXISTS tollbooths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  upstream_url TEXT NOT NULL,
  -- Public receiving address (EIP-55 checksummed). Never a secret.
  pay_to TEXT NOT NULL,
  network TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  forward_host_header INTEGER NOT NULL DEFAULT 0 CHECK (forward_host_header IN (0, 1)),
  -- micro-USDC for requests matching no route; NULL = refuse them.
  default_price INTEGER CHECK (default_price IS NULL OR default_price >= 0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tollbooth_routes (
  id TEXT PRIMARY KEY,
  tollbooth_id TEXT NOT NULL REFERENCES tollbooths(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path_pattern TEXT NOT NULL,
  -- micro-USDC; 0 = free pass-through.
  price INTEGER NOT NULL CHECK (price >= 0),
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tollbooth_routes_tollbooth ON tollbooth_routes(tollbooth_id);

-- One row per paid call that reached the upstream. No FK to tollbooths on
-- purpose: income history survives deleting a toll booth (name/slug are
-- snapshotted for display).
CREATE TABLE IF NOT EXISTS earnings (
  id TEXT PRIMARY KEY,
  tollbooth_id TEXT NOT NULL,
  tollbooth_slug TEXT NOT NULL,
  tollbooth_name TEXT NOT NULL,
  route_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  payer TEXT,
  tx_hash TEXT,
  network TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('settled', 'failed')),
  upstream_status INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_created ON earnings(created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_tollbooth_created ON earnings(tollbooth_id, created_at);
