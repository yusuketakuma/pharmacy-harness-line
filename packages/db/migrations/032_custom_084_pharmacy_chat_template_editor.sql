-- Additive: NULL preserves approval of templates written before this migration.
ALTER TABLE pharmacy_chat_templates ADD COLUMN last_edited_by_staff_id TEXT REFERENCES staff_members(id);

CREATE TRIGGER pharmacy_chat_templates_editor_scope_insert
BEFORE INSERT ON pharmacy_chat_templates
WHEN NEW.last_edited_by_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_staff_accounts AS assignment
  INNER JOIN tenant_line_accounts AS mapping ON mapping.line_account_id = assignment.line_account_id
  INNER JOIN tenant_staff_memberships AS membership
    ON membership.tenant_id = mapping.tenant_id AND membership.staff_id = assignment.staff_id AND membership.is_active = 1
  INNER JOIN staff_members AS staff ON staff.id = assignment.staff_id AND staff.is_active = 1 AND staff.principal_kind = 'human'
  WHERE assignment.line_account_id = NEW.line_account_id AND assignment.staff_id = NEW.last_edited_by_staff_id AND assignment.is_active = 1
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_chat_templates_editor_scope_update
BEFORE UPDATE OF last_edited_by_staff_id ON pharmacy_chat_templates
WHEN NEW.last_edited_by_staff_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pharmacy_staff_accounts AS assignment
  INNER JOIN tenant_line_accounts AS mapping ON mapping.line_account_id = assignment.line_account_id
  INNER JOIN tenant_staff_memberships AS membership
    ON membership.tenant_id = mapping.tenant_id AND membership.staff_id = assignment.staff_id AND membership.is_active = 1
  INNER JOIN staff_members AS staff ON staff.id = assignment.staff_id AND staff.is_active = 1 AND staff.principal_kind = 'human'
  WHERE assignment.line_account_id = NEW.line_account_id AND assignment.staff_id = NEW.last_edited_by_staff_id AND assignment.is_active = 1
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH'); END;

CREATE TRIGGER pharmacy_chat_templates_editor_approval_insert
BEFORE INSERT ON pharmacy_chat_templates
WHEN NEW.approved_by_staff_id IS NOT NULL AND NEW.approved_by_staff_id = NEW.last_edited_by_staff_id
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_EDITOR_APPROVAL'); END;

CREATE TRIGGER pharmacy_chat_templates_editor_approval_update
BEFORE UPDATE ON pharmacy_chat_templates
WHEN NEW.approved_by_staff_id IS NOT NULL AND NEW.approved_by_staff_id = NEW.last_edited_by_staff_id
BEGIN SELECT RAISE(ABORT, 'PHARMACY_CHAT_TEMPLATE_EDITOR_APPROVAL'); END;
