-- ADMIN
-- email: admin@adm.in
-- password: adminadmin

-- DEFAULT
-- email: user@us.er
-- password: useruser

INSERT IGNORE INTO `user` (`id`, `email`, `password`, `name`, `role`) VALUES
('seed_03b02de9-a5f9-485d-a9c4-7f1e926d0775', 'admin@adm.in', '$2b$10$L5KJWKcyOZDT4NVD5k8XoeecgREzeE1eoc9rm3SOC8BOjPwTd4pYW', 'Admin User', 'admin'),
('seed_16f22dee-f023-4c23-8bb4-7f28eda49567', 'user@us.er', '$2b$10$58BeO4MzuiLM2uaTpFLSRODdoIv2rxhDmuhg1kh3ojW61IrBiPp4e', 'Default User', 'user');
