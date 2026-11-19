INSERT INTO groups (slug, name, description, is_superadmin, is_system)
VALUES ('admin', 'Administrators', 'Full access to everything', TRUE, TRUE)
ON DUPLICATE KEY UPDATE is_superadmin = TRUE, is_system = TRUE;
