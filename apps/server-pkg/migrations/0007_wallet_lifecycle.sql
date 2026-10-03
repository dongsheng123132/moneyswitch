-- Wallet lifecycle: recovery-phrase backup confirmation and retired wallets.
--
-- Background: users lost access to a funded wallet twice because the server
-- needs the wallet password on every restart, creating a wallet never made
-- anyone keep it, and there was no second way back in. From this migration on
-- the server records (a) whether the operator proved they wrote down the
-- recovery phrase and (b) every wallet that was replaced, so nothing is ever
-- "forgotten" even though the key files are only ever moved, never deleted.
--
-- Additive only, so it upgrades an existing database in place. wallet_meta
-- existed since 0000 but nothing wrote to it; a database that already has no
-- rows keeps working (the server treats "no row" as "backup not confirmed").
-- (The migration runner wraps this file in one transaction.)

-- One row per wallet address the server has managed: id = lower-case 0x address.
-- backup_confirmed_at is set when the operator answered the two-word check (or
-- when the wallet was imported, i.e. the operator already held its credential).
ALTER TABLE wallet_meta ADD COLUMN backup_confirmed_at TEXT;
-- 'generated' (created by the server) | 'imported' (recovery phrase, private key or keystore)
ALTER TABLE wallet_meta ADD COLUMN origin TEXT;

-- A wallet that was replaced (POST /v1/admin/wallet/replace). The key files are
-- moved to <dataDir>/retired/ under the names recorded here and are never
-- deleted by MoneySwitch. Payments keep their original auth_from address, so
-- on-chain reconciliation of old payments does not depend on this table.
CREATE TABLE IF NOT EXISTS wallet_retirements (
  id TEXT PRIMARY KEY,
  -- checksummed 0x address of the retired wallet
  address TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  -- free text chosen by the operator, e.g. 'lost_password' or 'suspected_leak'
  reason TEXT NOT NULL,
  -- file names inside <dataDir>/retired/ (never absolute paths)
  keystore_file TEXT NOT NULL,
  -- NULL when the old wallet had no auto-unlock secret
  secret_file TEXT,
  -- address of the wallet that took its place
  replaced_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_wallet_retirements_retired_at
  ON wallet_retirements(retired_at);
