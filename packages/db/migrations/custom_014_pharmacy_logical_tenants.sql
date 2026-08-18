-- One shared Cloudflare deployment, logically separated by pharmacy tenant.
-- Existing installations are backfilled conservatively as one tenant per
-- LINE account; accounts may be grouped only by an explicit later operation.

CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  tenant_code  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'suspended')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tenant_line_accounts (
  tenant_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, line_account_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_line_accounts_tenant
  ON tenant_line_accounts (tenant_id, line_account_id);

CREATE TABLE IF NOT EXISTS tenant_staff_memberships (
  tenant_id  TEXT NOT NULL,
  staff_id   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, staff_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_staff_memberships_staff
  ON tenant_staff_memberships (staff_id, is_active, tenant_id);

INSERT OR IGNORE INTO tenants
  (id, tenant_code, display_name, status, created_at, updated_at)
SELECT 'tenant:' || id, id, name, 'active',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM line_accounts;

INSERT OR IGNORE INTO tenant_line_accounts
  (tenant_id, line_account_id, created_at, updated_at)
SELECT 'tenant:' || id, id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM line_accounts;

-- This repository is the pharmacy product. Fail closed during migration by
-- putting every adopted account behind the pharmacy capability allowlist.
INSERT OR IGNORE INTO pharmacy_account_capabilities
  (line_account_id, mode, capabilities_json, proactive_monthly_limit,
   unfollow_alert_state, created_at, updated_at)
SELECT id, 'pharmacy',
       '["prescription_intake","patient_intake","fulfillment_quote","continuity","medication_followup","manual_chat","pharmacy_rich_menu","account_settings","pharmacy_dashboard"]',
       1, 'alert_only',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM line_accounts;

INSERT OR IGNORE INTO tenant_staff_memberships
  (tenant_id, staff_id, role, is_active, created_at, updated_at)
SELECT mapping.tenant_id, assignment.staff_id, staff.role,
       assignment.is_active, assignment.created_at, assignment.updated_at
  FROM pharmacy_staff_accounts AS assignment
  INNER JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = assignment.line_account_id
  INNER JOIN staff_members AS staff ON staff.id = assignment.staff_id;
