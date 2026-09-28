CREATE TABLE pharmacy_chat_templates (
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  template_id          TEXT NOT NULL CHECK (length(template_id) BETWEEN 8 AND 128),
  title                TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body                 TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  status               TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
  version              INTEGER NOT NULL CHECK (version >= 1),
  created_by_staff_id  TEXT NOT NULL,
  approved_by_staff_id TEXT,
  approved_at          TEXT,
  created_at           TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at           TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  PRIMARY KEY (line_account_id, template_id),
  FOREIGN KEY (line_account_id, created_by_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, approved_by_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  CHECK (approved_at IS NULL OR unixepoch(approved_at) IS NOT NULL),
  CHECK (
    (status = 'approved' AND approved_by_staff_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (status != 'approved' AND approved_by_staff_id IS NULL AND approved_at IS NULL)
  ),
  CHECK (approved_by_staff_id IS NULL OR approved_by_staff_id != created_by_staff_id)
);

CREATE INDEX idx_pharmacy_chat_templates_status
  ON pharmacy_chat_templates(line_account_id, status);

CREATE TRIGGER pharmacy_chat_templates_staff_scope_insert
BEFORE INSERT ON pharmacy_chat_templates
WHEN NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.created_by_staff_id
           AND membership.is_active = 1
    INNER JOIN staff_members AS staff
            ON staff.id = NEW.created_by_staff_id
           AND staff.is_active = 1
           AND staff.principal_kind = 'human'
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.created_by_staff_id
           AND assignment.is_active = 1
   WHERE mapping.line_account_id = NEW.line_account_id
)
OR (NEW.approved_by_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.approved_by_staff_id
           AND membership.is_active = 1
    INNER JOIN staff_members AS staff
            ON staff.id = NEW.approved_by_staff_id
           AND staff.is_active = 1
           AND staff.principal_kind = 'human'
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.approved_by_staff_id
           AND assignment.is_active = 1
   WHERE mapping.line_account_id = NEW.line_account_id
))
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_chat_templates_staff_scope_update
BEFORE UPDATE OF line_account_id, created_by_staff_id, approved_by_staff_id
ON pharmacy_chat_templates
WHEN NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.created_by_staff_id
           AND membership.is_active = 1
    INNER JOIN staff_members AS staff
            ON staff.id = NEW.created_by_staff_id
           AND staff.is_active = 1
           AND staff.principal_kind = 'human'
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.created_by_staff_id
           AND assignment.is_active = 1
   WHERE mapping.line_account_id = NEW.line_account_id
)
OR (NEW.approved_by_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM tenant_line_accounts AS mapping
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = mapping.tenant_id
           AND membership.staff_id = NEW.approved_by_staff_id
           AND membership.is_active = 1
    INNER JOIN staff_members AS staff
            ON staff.id = NEW.approved_by_staff_id
           AND staff.is_active = 1
           AND staff.principal_kind = 'human'
    INNER JOIN pharmacy_staff_accounts AS assignment
            ON assignment.line_account_id = NEW.line_account_id
           AND assignment.staff_id = NEW.approved_by_staff_id
           AND assignment.is_active = 1
   WHERE mapping.line_account_id = NEW.line_account_id
))
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_chat_templates_identity_immutable
BEFORE UPDATE OF line_account_id, template_id, created_by_staff_id, created_at
ON pharmacy_chat_templates
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_IDENTITY_IMMUTABLE'); END;
