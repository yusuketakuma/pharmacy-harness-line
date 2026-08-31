CREATE TRIGGER tenant_status_revoke_admin_sessions
AFTER UPDATE OF status ON tenants
WHEN OLD.status = 'active' AND NEW.status = 'suspended'
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tenant_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER tenant_membership_revoke_admin_sessions
AFTER UPDATE OF is_active ON tenant_staff_memberships
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE tenant_id = NEW.tenant_id AND staff_id = NEW.staff_id
     AND revoked_at IS NULL; END;

CREATE TRIGGER platform_admin_revoke_sessions
AFTER UPDATE OF is_active ON platform_admins
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER platform_admin_revoke_grants
AFTER UPDATE OF is_active ON platform_admins
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_access_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revoked_by = 'system:platform_admin_disabled'
   WHERE platform_admin_id = NEW.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER staff_member_revoke_tenant_sessions
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE tenant_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER staff_member_revoke_platform_sessions
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE staff_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER staff_member_revoke_platform_grants
AFTER UPDATE OF is_active ON staff_members
WHEN OLD.is_active = 1 AND NEW.is_active = 0
BEGIN
  UPDATE platform_admin_access_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revoked_by = 'system:staff_disabled'
   WHERE platform_admin_id = NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER tenant_admin_session_authority_guard
BEFORE INSERT ON tenant_admin_sessions
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM tenants AS tenant
    INNER JOIN tenant_staff_memberships AS membership
            ON membership.tenant_id = tenant.id
           AND membership.staff_id = NEW.staff_id
    INNER JOIN staff_members AS staff ON staff.id = membership.staff_id
    INNER JOIN tenant_admin_credentials AS credential
            ON credential.tenant_id = membership.tenant_id
           AND credential.staff_id = membership.staff_id
   WHERE tenant.id = NEW.tenant_id
     AND tenant.status = 'active'
     AND membership.is_active = 1
     AND staff.is_active = 1
     AND credential.credential_version = NEW.credential_version
)
BEGIN
  SELECT RAISE(ABORT, 'inactive tenant admin authority'); END;

CREATE TRIGGER platform_admin_session_authority_guard
BEFORE INSERT ON platform_admin_sessions
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM platform_admins AS admin
    INNER JOIN staff_members AS staff ON staff.id = admin.staff_id
    INNER JOIN platform_admin_credentials AS credential
            ON credential.staff_id = admin.staff_id
   WHERE admin.staff_id = NEW.staff_id
     AND admin.is_active = 1
     AND staff.is_active = 1
     AND credential.credential_version = NEW.credential_version
)
BEGIN
  SELECT RAISE(ABORT, 'inactive platform admin authority'); END;

CREATE TRIGGER platform_admin_access_grant_authority_guard
BEFORE INSERT ON platform_admin_access_grants
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1
    FROM platform_admin_sessions AS session
    INNER JOIN platform_admins AS admin
            ON admin.staff_id = session.staff_id
    INNER JOIN staff_members AS staff
            ON staff.id = admin.staff_id
    INNER JOIN platform_admin_credentials AS credential
            ON credential.staff_id = admin.staff_id
           AND credential.credential_version = session.credential_version
   WHERE session.token_hash = NEW.session_token_hash
     AND session.staff_id = NEW.platform_admin_id
     AND session.revoked_at IS NULL
     AND session.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND admin.is_active = 1
     AND staff.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'active/current platform admin session authority required'); END;
