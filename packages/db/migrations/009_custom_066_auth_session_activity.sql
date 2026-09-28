ALTER TABLE tenant_admin_sessions
  ADD COLUMN last_seen_at TEXT
  CHECK (last_seen_at IS NULL OR unixepoch(last_seen_at) IS NOT NULL);

ALTER TABLE platform_admin_sessions
  ADD COLUMN last_seen_at TEXT
  CHECK (last_seen_at IS NULL OR unixepoch(last_seen_at) IS NOT NULL);
