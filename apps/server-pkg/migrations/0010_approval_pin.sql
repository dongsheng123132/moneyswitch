-- Approval PIN: the 4-6 digit code of the person who holds a root key (v0.7.4). With it that person approves or denies requests of the
-- key and its child keys from the approval link; the AI never has it.
--
-- Additive only (the migration runner wraps this file in one transaction):
--   approval_pin           'scrypt$<salt hex>$<hash hex>', a salted slow hash, never the PIN. NULL = no PIN: a key issued before this
--                          column existed (until the administrator sets one), and every child key (it uses its root key's).
--   approval_pin_failures  wrong PINs since the PIN was last set (a right PIN does not reset it); 5 locks the PIN until the administrator
--                          sets a new one (which resets it to 0).
ALTER TABLE money_keys ADD COLUMN approval_pin TEXT;
ALTER TABLE money_keys ADD COLUMN approval_pin_failures INTEGER NOT NULL DEFAULT 0;
