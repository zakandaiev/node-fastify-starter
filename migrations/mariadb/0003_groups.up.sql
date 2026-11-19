CREATE TABLE groups (
  id UUID NOT NULL DEFAULT UUID_v7(),
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  description VARCHAR(255) COLLATE utf8mb4_uca1400_ai_ci NULL,
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Grants every scope, as the scope *',
  is_system BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Made by a seed: never deleted',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_groups_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Groups of users, each a set of scopes';
