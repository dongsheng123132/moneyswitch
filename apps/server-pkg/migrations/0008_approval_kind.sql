-- Approval kind: a payment over the approval line (the only kind until now) or a request to a host outside the key's allowed list.
--
-- Additive only (the migration runner wraps this file in one transaction): every existing row is a payment approval, which is
-- exactly what the default says. A 'host' approval is created before any request leaves for the unknown host, so there is no
-- price yet: network / asset / pay_to are stored as '' and amount as 0 (those columns are NOT NULL).
ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment';
