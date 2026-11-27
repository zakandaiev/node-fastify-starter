ALTER TABLE audit_logs
  DROP FOREIGN KEY fk_audit_logs_actor,
  DROP INDEX idx_audit_logs_actor,
  MODIFY COLUMN actor_id UUID NULL COMMENT 'The user who acted, kept once that user is deleted; NULL for the system';
