CREATE TABLE audit_logs (
  id UUID NOT NULL DEFAULT UUID_v7(),
  actor_id UUID NULL COMMENT 'The user who acted; NULL for the system, and once that user is deleted',
  action VARCHAR(64) NOT NULL COMMENT 'A code of the audit actions in the code: the code gives the set, so there is no CHECK',
  entity_type VARCHAR(64) NULL COMMENT 'The table of the object acted on',
  entity_id UUID NULL,
  meta JSON NULL,
  ip VARCHAR(45) NULL,
  request_id UUID NULL COMMENT 'The id of the request that acted, as its log lines carry it; NULL outside a request',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_logs_actor (actor_id),
  KEY idx_audit_logs_entity (entity_type, entity_id),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Sensitive actions, each written in the transaction of the action itself';
