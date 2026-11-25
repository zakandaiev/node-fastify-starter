-- Nothing a refresh changes may join user_id in idx_sessions_user. It is the index of the foreign key: an update of it
-- makes InnoDB check that key again, and so lock the row of the user after the row of the session. No index on the hash:
-- a session is found by its id, and a unique one would lock an entry of another sign-in when a rotation is taken back.
CREATE TABLE sessions (
  id UUID NOT NULL DEFAULT UUID_v7() COMMENT 'The sid of the tokens',
  user_id UUID NOT NULL,
  refresh_token_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256, in hex, of the one refresh token that is current',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'The sign-in',
  rotated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'The last activity: the sign-in or the last refresh',
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL COMMENT 'NULL while the session is live',
  user_agent VARCHAR(255) NULL,
  ip VARCHAR(45) NULL,
  is_dev BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Made by the sign-in of dev mode',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Sign-ins of users on their devices; a revoked or expired row stays until it is cleaned up';
