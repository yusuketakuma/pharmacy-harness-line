-- Time-limited support-mode access grants. A platform admin session alone
-- is no longer sufficient to read patient PHI (prescriptions, intake,
-- myna, continuity) — reading it also requires an active grant, scoped to
-- exactly one tenant, with a reason, an optional ticket reference, a
-- short expiry, and a step-up password re-verification timestamp. This
-- turns "always-on god mode" into "break-glass, logged, time-boxed access",
-- per the reviewed design (platform_admin_access_grants).

CREATE TABLE IF NOT EXISTS platform_admin_access_grants (
  id                 TEXT PRIMARY KEY,
  platform_admin_id  TEXT NOT NULL REFERENCES platform_admins(staff_id),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  scopes             TEXT NOT NULL,       -- JSON array, e.g. ["phi:read"]
  reason             TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  ticket_reference   TEXT,
  reauth_verified_at TEXT NOT NULL,       -- step-up: current password re-checked at grant issue time
  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoked_by         TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_access_grants_active
  ON platform_admin_access_grants (platform_admin_id, tenant_id, expires_at, revoked_at);
