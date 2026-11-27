ALTER TABLE users
  ADD COLUMN avatar_key VARCHAR(64) NULL COMMENT 'The key of the avatar in the upload storage, not its URL: the URL follows the address of the app; NULL without an avatar' AFTER timezone;
