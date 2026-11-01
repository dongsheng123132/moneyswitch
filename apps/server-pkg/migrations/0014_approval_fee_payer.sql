-- The Solana fee sponsor named in the seller's 402 quote (extra.feePayer), recorded with the approval so the approval screen can say
-- which wallet pays the network fee. NULL for EVM payments and for approvals created before this column existed.
--
-- Additive only (the migration runner wraps this file in one transaction): nullable, no default, no backfill.
ALTER TABLE approvals ADD COLUMN fee_payer TEXT;
