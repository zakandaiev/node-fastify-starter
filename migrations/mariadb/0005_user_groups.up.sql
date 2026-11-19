CREATE TABLE user_groups (
  user_id UUID NOT NULL,
  group_id UUID NOT NULL,
  granted_by UUID NULL COMMENT 'The user who granted it; NULL for the system, and once that user is deleted',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, group_id),
  KEY idx_user_groups_group (group_id),
  KEY idx_user_groups_granted_by (granted_by),
  CONSTRAINT fk_user_groups_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_groups_group FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_groups_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Members of each group';
