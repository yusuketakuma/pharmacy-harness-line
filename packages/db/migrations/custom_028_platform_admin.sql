-- Platform-wide administrator: sits above each tenant's own admin
-- (tenant_staff_memberships) and can view/edit across every tenant. Reuses
-- the same proven pattern as tenant_admin_credentials / tenant_admin_sessions
-- (opaque hashed session tokens, credential_version, must_change_password),
-- but is deliberately a SEPARATE set of tables, a separate cookie, and a
-- separate middleware (see custom/pharmacy/platform-admin/auth.ts) so a
-- platform-admin session can never be confused with, or silently accepted
-- as, a tenant-admin session, and vice versa.
--
-- Every cross-tenant read or write this role performs must be recorded in
-- platform_admin_access_events — this is the single most important
-- safeguard for a role whose entire purpose is to bypass the tenant
-- boundaries the rest of this schema enforces.

CREATE TABLE IF NOT EXISTS platform_admins (
  staff_id   TEXT PRIMARY KEY REFERENCES staff_members(id) ON DELETE CASCADE,
  granted_by TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_admin_credentials (
  staff_id             TEXT PRIMARY KEY
                        REFERENCES platform_admins(staff_id) ON DELETE CASCADE,
  login_id             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1
                        CHECK (must_change_password IN (0, 1)),
  credential_version   INTEGER NOT NULL DEFAULT 1
                        CHECK (credential_version >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  token_hash         TEXT PRIMARY KEY
                      CHECK (length(token_hash) = 64
                             AND token_hash NOT GLOB '*[^0-9a-f]*'),
  staff_id           TEXT NOT NULL
                      REFERENCES platform_admins(staff_id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  session_kind       TEXT NOT NULL CHECK (session_kind IN ('bootstrap', 'standard')),
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_sessions_staff
  ON platform_admin_sessions (staff_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS platform_admin_access_events (
  id                TEXT PRIMARY KEY,
  platform_admin_id TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id         TEXT REFERENCES tenants(id),
  action            TEXT NOT NULL,
  resource_type     TEXT,
  resource_id       TEXT,
  detail_json       TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_access_events_admin
  ON platform_admin_access_events (platform_admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_admin_access_events_tenant
  ON platform_admin_access_events (tenant_id, created_at);
