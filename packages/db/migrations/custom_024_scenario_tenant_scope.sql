-- M-1: give scenarios an explicit tenant so the delivery boundary is enforced
-- in SQL instead of in JS.
--
-- A scenario with no line_account_id means "every account of the owner".
-- Before multitenancy that was unambiguous; on the shared Worker it matched
-- every tenant's inbound messages, because nothing linked the scenario to the
-- tenant that created it.

ALTER TABLE scenarios ADD COLUMN tenant_id TEXT;

-- Account-bound scenarios inherit the tenant that owns their account.
UPDATE scenarios
   SET tenant_id = (SELECT mapping.tenant_id
                      FROM tenant_line_accounts AS mapping
                     WHERE mapping.line_account_id = scenarios.line_account_id)
 WHERE tenant_id IS NULL
   AND line_account_id IS NOT NULL;

-- Account-unassigned scenarios predate multitenancy and carry no attribution.
-- They can be attributed only when the installation has exactly one tenant.
-- Otherwise they stay unattributed and match nothing (fail closed).
UPDATE scenarios
   SET tenant_id = (SELECT id FROM tenants)
 WHERE tenant_id IS NULL
   AND line_account_id IS NULL
   AND (SELECT COUNT(*) FROM tenants) = 1;

CREATE INDEX IF NOT EXISTS idx_scenarios_tenant_account
  ON scenarios (tenant_id, line_account_id);
