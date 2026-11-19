CREATE TABLE group_scopes (
  group_id UUID NOT NULL,
  scope VARCHAR(64) NOT NULL COMMENT 'A code of the scope catalog in the code: there is no table of scopes',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id, scope),
  CONSTRAINT fk_group_scopes_group FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Scopes each group grants';
