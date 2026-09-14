ALTER TABLE staff_members
  ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'human'
  CHECK (principal_kind IN ('human', 'pharmacy_shared'));

ALTER TABLE staff_members
  ADD COLUMN shared_tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE tenant_admin_credentials
  ADD COLUMN auth_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auth_enabled IN (0, 1));

ALTER TABLE tenant_admin_audit_events
  ADD COLUMN actor_kind TEXT CHECK (
    actor_kind IS NULL OR actor_kind IN ('human', 'pharmacy_shared', 'platform_admin', 'system')
  );

ALTER TABLE tenant_admin_audit_events
  ADD COLUMN outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('success', 'failure', 'denied', 'unavailable')
  );

CREATE UNIQUE INDEX ux_pharmacy_shared_staff_tenant
  ON staff_members(shared_tenant_id)
  WHERE principal_kind = 'pharmacy_shared';

CREATE INDEX idx_pharmacy_shared_staff_tenant
  ON staff_members(shared_tenant_id, is_active)
  WHERE principal_kind = 'pharmacy_shared';

CREATE TABLE pharmacy_auth_audit_events (
  id               TEXT PRIMARY KEY NOT NULL,
  actor_kind       TEXT NOT NULL CHECK (
    actor_kind IN ('pharmacy_shared', 'platform_admin', 'human', 'unauthenticated', 'system')
  ),
  actor_staff_id   TEXT REFERENCES staff_members(id) ON DELETE RESTRICT,
  target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT,
  target_staff_id  TEXT REFERENCES staff_members(id) ON DELETE RESTRICT,
  action           TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 64),
  outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'unavailable')),
  reason_code      TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 64),
  request_id       TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 128),
  created_at       TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) WITHOUT ROWID;

CREATE INDEX idx_pharmacy_auth_audit_tenant_created
  ON pharmacy_auth_audit_events(target_tenant_id, created_at);

CREATE INDEX idx_pharmacy_auth_audit_actor_created
  ON pharmacy_auth_audit_events(actor_staff_id, created_at);

CREATE TRIGGER pharmacy_auth_audit_insert_guard
BEFORE INSERT ON pharmacy_auth_audit_events
WHEN EXISTS (
  SELECT 1 FROM pharmacy_auth_audit_events AS existing
   WHERE existing.id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_AUTH_AUDIT_ID_REUSE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_staff_insert_guard
BEFORE INSERT ON staff_members
WHEN (NEW.principal_kind = 'pharmacy_shared' AND
      (NEW.role <> 'admin' OR NEW.shared_tenant_id IS NULL))
  OR (NEW.principal_kind = 'human' AND NEW.shared_tenant_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_STAFF_IDENTITY_INVALID'); END;

CREATE TRIGGER pharmacy_shared_staff_insert_collision_guard
BEFORE INSERT ON staff_members
WHEN EXISTS (
    SELECT 1 FROM staff_members AS existing
     WHERE existing.id = NEW.id
       AND (existing.principal_kind = 'pharmacy_shared'
            OR NEW.principal_kind = 'pharmacy_shared')
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_STAFF_ID_REUSE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_staff_update_guard
BEFORE UPDATE OF id, principal_kind, shared_tenant_id, role ON staff_members
WHEN NEW.principal_kind <> OLD.principal_kind
  OR NEW.id <> OLD.id
  OR COALESCE(NEW.shared_tenant_id, '') <> COALESCE(OLD.shared_tenant_id, '')
  OR (NEW.principal_kind = 'pharmacy_shared' AND NEW.role <> 'admin')
  OR (NEW.principal_kind = 'human' AND NEW.shared_tenant_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_STAFF_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_shared_staff_delete_guard
BEFORE DELETE ON staff_members
WHEN OLD.principal_kind = 'pharmacy_shared'
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_STAFF_DELETE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_membership_insert_guard
BEFORE INSERT ON tenant_staff_memberships
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = NEW.staff_id
     AND staff.principal_kind = 'pharmacy_shared'
     AND (staff.shared_tenant_id IS NULL OR staff.shared_tenant_id <> NEW.tenant_id OR NEW.role <> 'admin')
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_MEMBERSHIP_SCOPE_INVALID'); END;

CREATE TRIGGER pharmacy_shared_membership_insert_collision_guard
BEFORE INSERT ON tenant_staff_memberships
WHEN EXISTS (
  SELECT 1 FROM tenant_staff_memberships AS existing
   LEFT JOIN staff_members AS staff ON staff.id = existing.staff_id
   LEFT JOIN staff_members AS new_staff ON new_staff.id = NEW.staff_id
  WHERE existing.tenant_id = NEW.tenant_id
    AND existing.staff_id = NEW.staff_id
    AND (staff.principal_kind = 'pharmacy_shared' OR new_staff.principal_kind = 'pharmacy_shared')
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_MEMBERSHIP_ID_REUSE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_membership_update_guard
BEFORE UPDATE OF tenant_id, staff_id, role ON tenant_staff_memberships
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = NEW.staff_id
     AND staff.principal_kind = 'pharmacy_shared'
     AND (staff.shared_tenant_id IS NULL OR staff.shared_tenant_id <> NEW.tenant_id OR NEW.role <> 'admin')
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_MEMBERSHIP_SCOPE_INVALID'); END;

CREATE TRIGGER pharmacy_shared_membership_identity_guard
BEFORE UPDATE OF tenant_id, staff_id, role ON tenant_staff_memberships
WHEN (NEW.tenant_id <> OLD.tenant_id OR NEW.staff_id <> OLD.staff_id OR NEW.role <> OLD.role)
  AND (
    EXISTS (SELECT 1 FROM staff_members WHERE id = OLD.staff_id AND principal_kind = 'pharmacy_shared')
    OR EXISTS (SELECT 1 FROM staff_members WHERE id = NEW.staff_id AND principal_kind = 'pharmacy_shared')
  )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_MEMBERSHIP_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_shared_membership_delete_guard
BEFORE DELETE ON tenant_staff_memberships
WHEN EXISTS (
  SELECT 1 FROM staff_members
   WHERE id = OLD.staff_id AND principal_kind = 'pharmacy_shared'
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_MEMBERSHIP_DELETE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_account_assignment_guard
BEFORE INSERT ON pharmacy_staff_accounts
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = NEW.staff_id AND staff.principal_kind = 'pharmacy_shared'
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_ACCOUNT_ASSIGNMENT_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_account_assignment_update_guard
BEFORE UPDATE OF staff_id ON pharmacy_staff_accounts
WHEN NEW.staff_id <> OLD.staff_id
  AND (
    EXISTS (SELECT 1 FROM staff_members WHERE id = OLD.staff_id AND principal_kind = 'pharmacy_shared')
    OR EXISTS (SELECT 1 FROM staff_members WHERE id = NEW.staff_id AND principal_kind = 'pharmacy_shared')
  )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_ACCOUNT_ASSIGNMENT_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_credential_insert_guard
BEFORE INSERT ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1
    FROM staff_members AS staff
    INNER JOIN tenants AS tenant ON tenant.id = NEW.tenant_id
   WHERE staff.id = NEW.staff_id AND staff.principal_kind = 'pharmacy_shared'
     AND (
       NEW.login_id COLLATE NOCASE <> tenant.tenant_code COLLATE NOCASE
       OR NEW.auth_enabled <> 1
       OR staff.shared_tenant_id <> NEW.tenant_id
       OR NOT EXISTS (
         SELECT 1 FROM tenant_staff_memberships AS membership
          WHERE membership.tenant_id = NEW.tenant_id
            AND membership.staff_id = NEW.staff_id
            AND membership.role = 'admin'
            AND membership.is_active = 1
       )
     )
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_CREDENTIAL_INVALID'); END;

CREATE TRIGGER pharmacy_shared_credential_insert_collision_guard
BEFORE INSERT ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1
    FROM tenant_admin_credentials AS existing
    LEFT JOIN staff_members AS old_staff ON old_staff.id = existing.staff_id
    LEFT JOIN staff_members AS new_staff ON new_staff.id = NEW.staff_id
   WHERE existing.tenant_id = NEW.tenant_id
     AND (existing.staff_id = NEW.staff_id OR existing.login_id = NEW.login_id COLLATE NOCASE)
     AND (old_staff.principal_kind = 'pharmacy_shared' OR new_staff.principal_kind = 'pharmacy_shared')
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_CREDENTIAL_ID_REUSE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_human_credential_insert_guard
BEFORE INSERT ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = NEW.staff_id
     AND staff.principal_kind = 'human'
     AND NEW.auth_enabled <> 0
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_HUMAN_CREDENTIAL_DISABLED'); END;

CREATE TRIGGER pharmacy_shared_credential_update_guard
BEFORE UPDATE OF tenant_id, staff_id, login_id, auth_enabled ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1
    FROM staff_members AS staff
    INNER JOIN tenants AS tenant ON tenant.id = NEW.tenant_id
  WHERE staff.id = NEW.staff_id AND staff.principal_kind = 'pharmacy_shared'
    AND NEW.auth_enabled <> 0
     AND (
       NEW.login_id COLLATE NOCASE <> tenant.tenant_code COLLATE NOCASE
       OR staff.shared_tenant_id <> NEW.tenant_id
       OR NOT EXISTS (
         SELECT 1 FROM tenant_staff_memberships AS membership
          WHERE membership.tenant_id = NEW.tenant_id
            AND membership.staff_id = NEW.staff_id
            AND membership.role = 'admin'
            AND membership.is_active = 1
       )
     )
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_CREDENTIAL_INVALID'); END;

CREATE TRIGGER pharmacy_shared_credential_identity_guard
BEFORE UPDATE OF tenant_id, staff_id, login_id ON tenant_admin_credentials
WHEN (OLD.tenant_id <> NEW.tenant_id
   OR OLD.staff_id <> NEW.staff_id
   OR OLD.login_id COLLATE NOCASE <> NEW.login_id COLLATE NOCASE)
  AND (
    EXISTS (SELECT 1 FROM staff_members WHERE id = OLD.staff_id AND principal_kind = 'pharmacy_shared')
    OR EXISTS (SELECT 1 FROM staff_members WHERE id = NEW.staff_id AND principal_kind = 'pharmacy_shared')
  )
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_CREDENTIAL_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_human_credential_update_guard
BEFORE UPDATE OF tenant_id, staff_id, login_id, auth_enabled ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = NEW.staff_id
     AND staff.principal_kind = 'human'
     AND NEW.auth_enabled <> 0
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_HUMAN_CREDENTIAL_DISABLED'); END;

CREATE TRIGGER pharmacy_shared_credential_delete_guard
BEFORE DELETE ON tenant_admin_credentials
WHEN EXISTS (
  SELECT 1 FROM staff_members AS staff
   WHERE staff.id = OLD.staff_id AND staff.principal_kind = 'pharmacy_shared'
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_CREDENTIAL_HISTORY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_shared_session_authority_guard
BEFORE INSERT ON tenant_admin_sessions
WHEN NEW.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM staff_members AS shared_staff
     WHERE shared_staff.id = NEW.staff_id
       AND shared_staff.principal_kind = 'pharmacy_shared'
  )
  AND NOT EXISTS (
  SELECT 1
    FROM tenant_admin_credentials AS credential
    INNER JOIN staff_members AS staff ON staff.id = credential.staff_id
    INNER JOIN tenants AS tenant ON tenant.id = credential.tenant_id
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = credential.tenant_id
           AND membership.staff_id = credential.staff_id
   WHERE credential.tenant_id = NEW.tenant_id
     AND credential.staff_id = NEW.staff_id
     AND credential.credential_version = NEW.credential_version
     AND credential.auth_enabled = 1
     AND staff.principal_kind = 'pharmacy_shared'
     AND staff.is_active = 1
     AND tenant.status = 'active'
     AND membership.role = 'admin'
     AND membership.is_active = 1
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SHARED_SESSION_AUTHORITY_REQUIRED'); END;

CREATE TRIGGER pharmacy_session_insert_collision_guard
BEFORE INSERT ON tenant_admin_sessions
WHEN EXISTS (
  SELECT 1 FROM tenant_admin_sessions AS existing
   WHERE existing.token_hash = NEW.token_hash
)
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SESSION_TOKEN_REUSE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_session_identity_immutable
BEFORE UPDATE OF token_hash, tenant_id, staff_id, credential_version, session_kind,
  session_family_hash, expires_at, created_at ON tenant_admin_sessions
WHEN NEW.tenant_id <> OLD.tenant_id
  OR NEW.token_hash <> OLD.token_hash
  OR NEW.staff_id <> OLD.staff_id
  OR NEW.credential_version <> OLD.credential_version
  OR NEW.session_kind <> OLD.session_kind
  OR COALESCE(NEW.session_family_hash, '') <> COALESCE(OLD.session_family_hash, '')
  OR NEW.expires_at <> OLD.expires_at
  OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SESSION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_session_revocation_immutable
BEFORE UPDATE OF revoked_at ON tenant_admin_sessions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SESSION_REVIVAL_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_session_delete_forbidden
BEFORE DELETE ON tenant_admin_sessions
BEGIN SELECT RAISE(ABORT, 'PHARMACY_SESSION_DELETE_FORBIDDEN'); END;

CREATE TRIGGER pharmacy_shared_credential_revoke_sessions
AFTER UPDATE OF auth_enabled, credential_version ON tenant_admin_credentials
WHEN (OLD.auth_enabled <> NEW.auth_enabled AND NEW.auth_enabled = 0)
   OR OLD.credential_version <> NEW.credential_version
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tenant_id = NEW.tenant_id
     AND staff_id = NEW.staff_id
     AND revoked_at IS NULL; END;

CREATE TRIGGER pharmacy_auth_audit_immutable
BEFORE UPDATE ON pharmacy_auth_audit_events
BEGIN SELECT RAISE(ABORT, 'PHARMACY_AUTH_AUDIT_IMMUTABLE'); END;

CREATE TRIGGER pharmacy_auth_audit_delete_forbidden
BEFORE DELETE ON pharmacy_auth_audit_events
BEGIN SELECT RAISE(ABORT, 'PHARMACY_AUTH_AUDIT_DELETE_FORBIDDEN'); END;

UPDATE tenant_admin_sessions
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM tenant_admin_credentials AS credential
      WHERE credential.tenant_id = tenant_admin_sessions.tenant_id
        AND credential.staff_id = tenant_admin_sessions.staff_id
        AND credential.auth_enabled = 0
   );
