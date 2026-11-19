CREATE TABLE users (
  id UUID NOT NULL DEFAULT UUID_v7(),
  email VARCHAR(254) NULL COMMENT 'Trimmed, in lower case and NFC: the code normalizes it before a write and a search',
  email_verified_at DATETIME(3) NULL,
  first_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
  last_name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NULL,
  locale VARCHAR(35) NULL COMMENT 'BCP 47 language tag; NULL until the user chooses one',
  timezone VARCHAR(64) NULL COMMENT 'IANA time zone, for notifications only; NULL until the user chooses one',
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status COLLATE utf8mb4_nopad_bin IN ('active', 'blocked')),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='People who sign in; a row is deleted for real, with its identities and memberships';
