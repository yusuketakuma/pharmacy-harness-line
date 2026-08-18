-- One platform-issued first owner per tenant. Additional staff are created by
-- the authenticated tenant owner after the first password login succeeds.
CREATE TABLE IF NOT EXISTS pharmacy_tenant_admin_bootstraps (
  tenant_id  TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES tenant_staff_memberships (tenant_id, staff_id) ON DELETE RESTRICT
);

-- New tenants already have a password owner. Mark them as bootstrapped so the
-- migration-only CLI cannot issue a second first owner.
INSERT OR IGNORE INTO pharmacy_tenant_admin_bootstraps (tenant_id, staff_id, created_at)
SELECT tenant_id, MIN(staff_id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM tenant_admin_credentials
 GROUP BY tenant_id;
