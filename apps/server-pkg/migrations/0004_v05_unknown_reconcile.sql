-- v0.5: on-chain reconciliation for `unknown` payments — a buyer signed an
-- EIP-3009 transferWithAuthorization but we never got a settle header back
-- (e.g. the seller's own upstream 500'd before it called /settle). Once the
-- authorization's validBefore has passed, we can ask the USDC contract
-- on-chain whether that (authorizer, nonce) was ever actually used and
-- reconcile the reservation to failed (quota released) or settled.
--
-- Additive only, so it upgrades an existing database in place. (The
-- migration runner wraps this file in one transaction.)

ALTER TABLE payments ADD COLUMN auth_from TEXT;
ALTER TABLE payments ADD COLUMN auth_nonce TEXT;
ALTER TABLE payments ADD COLUMN auth_valid_before INTEGER;
ALTER TABLE payments ADD COLUMN reconciled_at TEXT;

-- Reconciler's candidate scan: status='unknown' and not yet reconciled.
CREATE INDEX IF NOT EXISTS idx_payments_unknown_reconcile
  ON payments(status, auth_valid_before)
  WHERE reconciled_at IS NULL;
