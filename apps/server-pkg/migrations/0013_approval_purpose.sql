-- Preserve only the explicit, coarse Agent-supplied description; legacy records stay NULL.
ALTER TABLE approvals ADD COLUMN purpose TEXT;
