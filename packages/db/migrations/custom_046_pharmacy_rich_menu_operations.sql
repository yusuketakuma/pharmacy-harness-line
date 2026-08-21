-- Pharmacy v0.30 durable evidence for human-gated LINE rich-menu mutations.

CREATE TABLE IF NOT EXISTS pharmacy_rich_menu_lifecycle_controls (
  line_account_id  TEXT PRIMARY KEY,
  state            TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'frozen')),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (line_account_id)
    REFERENCES pharmacy_account_capabilities(line_account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pharmacy_rich_menu_operations (
  id                        TEXT PRIMARY KEY,
  group_id                  TEXT NOT NULL,
  line_account_id           TEXT NOT NULL,
  confirmation_id           TEXT NOT NULL UNIQUE CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  kind                      TEXT NOT NULL CHECK (kind IN ('publish', 'set_default', 'rollback')),
  status                    TEXT NOT NULL CHECK (status IN ('running', 'unknown', 'succeeded', 'failed')),
  evidence_digest           TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  publish_phase             TEXT CHECK (publish_phase IS NULL OR publish_phase IN (
                                'intent_recorded', 'remote_created', 'image_uploaded',
                                'alias_created', 'committed'
                              )),
  publish_alias_id          TEXT CHECK (publish_alias_id IS NULL OR length(publish_alias_id) BETWEEN 1 AND 100),
  publish_menu_name         TEXT CHECK (publish_menu_name IS NULL OR length(publish_menu_name) BETWEEN 1 AND 300),
  expected_default_menu_id  TEXT CHECK (expected_default_menu_id IS NULL OR length(expected_default_menu_id) > 0),
  default_read_at           TEXT,
  remote_rich_menu_id       TEXT CHECK (remote_rich_menu_id IS NULL OR length(remote_rich_menu_id) > 0),
  verified_default_menu_id  TEXT CHECK (verified_default_menu_id IS NULL OR length(verified_default_menu_id) > 0),
  reason_code               TEXT CHECK (reason_code IS NULL OR length(reason_code) > 0),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  verified_at               TEXT,
  FOREIGN KEY (group_id) REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  CHECK (
    (kind = 'publish' AND publish_phase IS NOT NULL
      AND publish_alias_id IS NOT NULL AND publish_menu_name IS NOT NULL)
    OR
    (kind <> 'publish' AND publish_phase IS NULL
      AND publish_alias_id IS NULL AND publish_menu_name IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_rich_menu_one_unresolved
  ON pharmacy_rich_menu_operations(line_account_id)
  WHERE status IN ('running', 'unknown');

CREATE INDEX IF NOT EXISTS idx_pharmacy_rich_menu_operations_group
  ON pharmacy_rich_menu_operations(line_account_id, group_id, created_at);

CREATE TABLE IF NOT EXISTS pharmacy_rich_menu_operation_confirmations (
  confirmation_id  TEXT PRIMARY KEY CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  operation_id     TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  publish_phase    TEXT NOT NULL CHECK (publish_phase IN (
                       'intent_recorded', 'remote_created', 'image_uploaded', 'alias_created'
                     )),
  evidence_digest  TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  created_at       TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES pharmacy_rich_menu_operations(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_rich_menu_operation_confirmations_operation
  ON pharmacy_rich_menu_operation_confirmations(line_account_id, operation_id, created_at);

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_resume_confirmation_scope
BEFORE INSERT ON pharmacy_rich_menu_operation_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM pharmacy_rich_menu_operations operation
   WHERE operation.id = NEW.operation_id
     AND operation.line_account_id = NEW.line_account_id
     AND operation.kind = 'publish'
     AND operation.status IN ('running', 'unknown')
     AND operation.publish_phase = NEW.publish_phase
     AND operation.evidence_digest = NEW.evidence_digest
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_RESUME_CONFIRMATION_EVIDENCE_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_insert_running
BEFORE INSERT ON pharmacy_rich_menu_operations
WHEN NEW.status <> 'running'
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_MUST_START_RUNNING'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_account_scope
BEFORE INSERT ON pharmacy_rich_menu_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM pharmacy_rich_menu_draft_bindings binding
    JOIN rich_menu_groups menu_group ON menu_group.id = binding.group_id
   WHERE binding.group_id = NEW.group_id
     AND binding.line_account_id = NEW.line_account_id
     AND menu_group.account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_ACCOUNT_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_identity_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.group_id IS NOT OLD.group_id
  OR NEW.line_account_id IS NOT OLD.line_account_id
  OR NEW.confirmation_id IS NOT OLD.confirmation_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.evidence_digest IS NOT OLD.evidence_digest
  OR NEW.publish_alias_id IS NOT OLD.publish_alias_id
  OR NEW.publish_menu_name IS NOT OLD.publish_menu_name
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_publish_phase_order
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.publish_phase IS NOT OLD.publish_phase
 AND NOT (
   (OLD.publish_phase = 'intent_recorded' AND NEW.publish_phase = 'remote_created')
   OR (OLD.publish_phase = 'remote_created' AND NEW.publish_phase = 'image_uploaded')
   OR (OLD.publish_phase = 'image_uploaded' AND NEW.publish_phase = 'alias_created')
   OR (OLD.publish_phase = 'alias_created' AND NEW.publish_phase = 'committed')
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PUBLISH_PHASE_INVALID'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_publish_phase_evidence
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.kind = 'publish'
 AND (
   (NEW.publish_phase IN ('remote_created', 'image_uploaded', 'alias_created', 'committed')
     AND NEW.remote_rich_menu_id IS NULL)
   OR
   (NEW.publish_phase = 'committed' AND NOT EXISTS (
     SELECT 1 FROM rich_menu_pages page
      WHERE page.group_id = NEW.group_id
        AND page.line_richmenu_id = NEW.remote_rich_menu_id
        AND page.alias_id = NEW.publish_alias_id
   ))
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PUBLISH_PHASE_EVIDENCE_REQUIRED'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_remote_id_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.remote_rich_menu_id IS NOT NULL
 AND NEW.remote_rich_menu_id IS NOT OLD.remote_rich_menu_id
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_REMOTE_ID_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_default_read_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.default_read_at IS NOT NULL
 AND (NEW.expected_default_menu_id IS NOT OLD.expected_default_menu_id
   OR NEW.default_read_at IS NOT OLD.default_read_at)
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_DEFAULT_READ_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_terminal_immutable
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.status IN ('succeeded', 'failed')
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_TERMINAL_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_no_resume_unknown
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN OLD.status = 'unknown' AND NEW.status = 'running'
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_UNKNOWN_REQUIRES_RECONCILIATION'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_success_evidence
BEFORE UPDATE ON pharmacy_rich_menu_operations
WHEN NEW.status = 'succeeded'
 AND (
   NEW.remote_rich_menu_id IS NULL
   OR NEW.verified_at IS NULL
   OR (NEW.kind = 'publish' AND NEW.publish_phase <> 'committed')
   OR (NEW.kind IN ('set_default', 'rollback')
     AND (NEW.default_read_at IS NULL
       OR NEW.verified_default_menu_id IS NOT NEW.remote_rich_menu_id))
 )
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_SUCCESS_EVIDENCE_REQUIRED'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_rich_menu_operation_protected_delete
BEFORE DELETE ON pharmacy_rich_menu_operations
WHEN OLD.status <> 'failed' OR OLD.remote_rich_menu_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'RICH_MENU_OPERATION_PROTECTED'); END;
