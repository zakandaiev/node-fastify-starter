UPDATE audit_logs SET actor_id = NULL WHERE actor_id IS NOT NULL AND actor_id NOT IN (SELECT id FROM users);

ALTER TABLE audit_logs
  MODIFY COLUMN actor_id UUID NULL COMMENT 'The user who acted; NULL for the system, and once that user is deleted',
  ADD KEY idx_audit_logs_actor (actor_id),
  ADD CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL;
