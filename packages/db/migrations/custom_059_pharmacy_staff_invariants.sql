-- Keep tenant ownership and pharmacy account assignment non-empty at the
-- serialized database write boundary. Application preflight checks remain for
-- friendly errors, while these triggers close concurrent-request races.

CREATE TRIGGER IF NOT EXISTS tenant_staff_memberships_keep_active_owner
BEFORE UPDATE OF tenant_id, staff_id, role, is_active ON tenant_staff_memberships
WHEN OLD.role = 'owner'
 AND OLD.is_active = 1
 AND (
   NEW.tenant_id != OLD.tenant_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.role != 'owner' OR
   NEW.is_active != 1
 )
 AND NOT EXISTS (
   SELECT 1
     FROM tenant_staff_memberships AS other
    WHERE other.tenant_id = OLD.tenant_id
      AND other.staff_id != OLD.staff_id
      AND other.role = 'owner'
      AND other.is_active = 1
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_OWNER'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_staff_accounts_keep_active_assignee
BEFORE UPDATE OF line_account_id, staff_id, is_active ON pharmacy_staff_accounts
WHEN OLD.is_active = 1
 AND (
   NEW.line_account_id != OLD.line_account_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.is_active != 1
 )
 AND EXISTS (
   SELECT 1
     FROM tenant_line_accounts AS mapping
     INNER JOIN tenant_staff_memberships AS membership
             ON membership.tenant_id = mapping.tenant_id
            AND membership.staff_id = OLD.staff_id
    WHERE mapping.line_account_id = OLD.line_account_id
      AND membership.is_active = 1
 )
 AND NOT EXISTS (
   SELECT 1
     FROM pharmacy_staff_accounts AS other
     INNER JOIN tenant_line_accounts AS mapping
             ON mapping.line_account_id = other.line_account_id
     INNER JOIN tenant_staff_memberships AS membership
             ON membership.tenant_id = mapping.tenant_id
            AND membership.staff_id = other.staff_id
    WHERE other.line_account_id = OLD.line_account_id
      AND other.staff_id != OLD.staff_id
      AND other.is_active = 1
      AND membership.is_active = 1
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE'); END;

CREATE TRIGGER IF NOT EXISTS tenant_staff_memberships_keep_account_assignee
BEFORE UPDATE OF tenant_id, staff_id, is_active ON tenant_staff_memberships
WHEN OLD.is_active = 1
 AND (
   NEW.tenant_id != OLD.tenant_id OR
   NEW.staff_id != OLD.staff_id OR
   NEW.is_active != 1
 )
 AND EXISTS (
   SELECT 1
     FROM pharmacy_staff_accounts AS target
     INNER JOIN tenant_line_accounts AS target_mapping
             ON target_mapping.line_account_id = target.line_account_id
    WHERE target.staff_id = OLD.staff_id
      AND target.is_active = 1
      AND target_mapping.tenant_id = OLD.tenant_id
      AND NOT EXISTS (
        SELECT 1
          FROM pharmacy_staff_accounts AS other
          INNER JOIN tenant_staff_memberships AS membership
                  ON membership.tenant_id = OLD.tenant_id
                 AND membership.staff_id = other.staff_id
         WHERE other.line_account_id = target.line_account_id
           AND other.staff_id != OLD.staff_id
           AND other.is_active = 1
           AND membership.is_active = 1
      )
 )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE'); END;
