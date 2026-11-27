ALTER TABLE user_identities
  ADD COLUMN is_email_verified BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Whether the provider confirmed the email at the last sign-in' AFTER email;
