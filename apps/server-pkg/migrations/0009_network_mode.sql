-- Network mode: which kind of chain a key pays on, 'testnet' or 'mainnet', chosen when the key is issued and never changed.
--
-- Additive only (the migration runner wraps this file in one transaction): NULL means a key issued before this column existed;
-- such a key keeps paying on every network the instance enables, exactly as it always did.
ALTER TABLE money_keys ADD COLUMN network_mode TEXT;
