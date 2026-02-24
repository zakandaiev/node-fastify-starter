-- ADMIN
-- email: admin@adm.in
-- password: adminadmin
SET @adminId = (UUID_v7());
SET @adminEmail = 'admin@adm.in';
SET @adminPassword = '$2b$10$L5KJWKcyOZDT4NVD5k8XoeecgREzeE1eoc9rm3SOC8BOjPwTd4pYW';
SET @adminName = '[SEED] Admin User';
SET @adminRole = 'admin';

-- DEFAULT
-- email: user@us.er
-- password: useruser
SET @defaultId = (UUID_v7());
SET @defaultEmail = 'user@us.er';
SET @defaultPassword = '$2b$10$58BeO4MzuiLM2uaTpFLSRODdoIv2rxhDmuhg1kh3ojW61IrBiPp4e';
SET @defaultName = '[SEED] Default User';
SET @defaultRole = 'user';

INSERT IGNORE INTO `users` (`id`, `email`, `password`, `name`, `role`) VALUES
(@adminId, @adminEmail, @adminPassword, @adminName, @adminRole),
(@defaultId, @defaultEmail, @defaultPassword, @defaultName, @defaultRole);
