-- Make the account-level pharmacy authorization explicit for tenants created
-- before provisioning began writing pharmacy_staff_accounts. This is additive
-- and idempotent; it does not grant access across tenant_line_accounts.
INSERT OR IGNORE INTO pharmacy_staff_accounts
  (line_account_id, staff_id, is_active, created_at, updated_at)
SELECT mapping.line_account_id,
       membership.staff_id,
       membership.is_active,
       membership.created_at,
       membership.updated_at
  FROM tenant_line_accounts AS mapping
  INNER JOIN tenant_staff_memberships AS membership
          ON membership.tenant_id = mapping.tenant_id
  INNER JOIN pharmacy_account_capabilities AS capability
          ON capability.line_account_id = mapping.line_account_id
         AND capability.mode = 'pharmacy';
