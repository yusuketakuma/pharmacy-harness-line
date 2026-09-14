CREATE TRIGGER pharmacy_followup_operations_staff_scope_insert
BEFORE INSERT ON pharmacy_medication_followup_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.primary_staff_id
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.primary_staff_id
   WHERE mapping.line_account_id = NEW.line_account_id
)
OR (NEW.backup_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.backup_staff_id
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.backup_staff_id
   WHERE mapping.line_account_id = NEW.line_account_id
))
BEGIN SELECT RAISE(ABORT, 'PHARMACY_FOLLOWUP_OPERATION_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_followup_operations_staff_scope_update
BEFORE UPDATE OF line_account_id, primary_staff_id, backup_staff_id
ON pharmacy_medication_followup_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.primary_staff_id
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.primary_staff_id
   WHERE mapping.line_account_id = NEW.line_account_id
)
OR (NEW.backup_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.backup_staff_id
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.backup_staff_id
   WHERE mapping.line_account_id = NEW.line_account_id
))
BEGIN SELECT RAISE(ABORT, 'PHARMACY_FOLLOWUP_OPERATION_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_followup_operations_enabled_staff_insert
BEFORE INSERT ON pharmacy_medication_followup_operations
WHEN NEW.enabled = 1 AND (
  NOT EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = NEW.primary_staff_id
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = NEW.primary_staff_id
             AND staff.is_active = 1
             AND staff.principal_kind = 'human'
      INNER JOIN pharmacy_staff_accounts AS assignment
              ON assignment.line_account_id = NEW.line_account_id
             AND assignment.staff_id = NEW.primary_staff_id
             AND assignment.is_active = 1
     WHERE mapping.line_account_id = NEW.line_account_id
  )
  OR (NEW.backup_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = NEW.backup_staff_id
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = NEW.backup_staff_id
             AND staff.is_active = 1
             AND staff.principal_kind = 'human'
      INNER JOIN pharmacy_staff_accounts AS assignment
              ON assignment.line_account_id = NEW.line_account_id
             AND assignment.staff_id = NEW.backup_staff_id
             AND assignment.is_active = 1
     WHERE mapping.line_account_id = NEW.line_account_id
  ))
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_FOLLOWUP_OPERATION_ENABLED_STAFF_INVALID'); END;

CREATE TRIGGER pharmacy_followup_operations_enabled_staff_update
BEFORE UPDATE OF line_account_id, primary_staff_id, backup_staff_id, enabled
ON pharmacy_medication_followup_operations
WHEN NEW.enabled = 1 AND (
  NOT EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = NEW.primary_staff_id
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = NEW.primary_staff_id
             AND staff.is_active = 1
             AND staff.principal_kind = 'human'
      INNER JOIN pharmacy_staff_accounts AS assignment
              ON assignment.line_account_id = NEW.line_account_id
             AND assignment.staff_id = NEW.primary_staff_id
             AND assignment.is_active = 1
     WHERE mapping.line_account_id = NEW.line_account_id
  )
  OR (NEW.backup_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS mapping
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = NEW.backup_staff_id
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = NEW.backup_staff_id
             AND staff.is_active = 1
             AND staff.principal_kind = 'human'
      INNER JOIN pharmacy_staff_accounts AS assignment
              ON assignment.line_account_id = NEW.line_account_id
             AND assignment.staff_id = NEW.backup_staff_id
             AND assignment.is_active = 1
     WHERE mapping.line_account_id = NEW.line_account_id
  ))
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_FOLLOWUP_OPERATION_ENABLED_STAFF_INVALID'); END;
