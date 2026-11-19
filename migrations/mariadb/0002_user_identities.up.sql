CREATE TABLE user_identities (
  id UUID NOT NULL DEFAULT UUID_v7(),
  user_id UUID NOT NULL,
  provider VARCHAR(32) NOT NULL COMMENT 'The id of a sign-in provider of the config: the config gives the set, so there is no CHECK',
  provider_user_id VARCHAR(255) NOT NULL,
  email VARCHAR(254) NULL,
  profile JSON NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_identities_provider_user (provider, provider_user_id),
  KEY idx_user_identities_user (user_id),
  CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Accounts of users at sign-in providers, several per user';
