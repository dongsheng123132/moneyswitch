-- Optional Agent-supplied purpose. Existing rows deliberately stay NULL;
-- no task history, prompt or request body is collected or inferred.
ALTER TABLE payments ADD COLUMN purpose TEXT;
