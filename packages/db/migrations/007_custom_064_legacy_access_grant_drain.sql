CREATE TRIGGER platform_admin_access_grant_session_required
BEFORE INSERT ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding required'); END;

CREATE TRIGGER platform_admin_access_grant_session_immutable
BEFORE UPDATE OF session_token_hash ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NOT OLD.session_token_hash
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding immutable'); END;

CREATE TRIGGER platform_admin_access_grant_reactivation_required
BEFORE UPDATE OF revoked_at ON platform_admin_access_grants
WHEN NEW.session_token_hash IS NULL AND NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access grant session binding required'); END;

UPDATE platform_admin_access_grants
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       revoked_by = 'system:v033_session_binding_required'
 WHERE session_token_hash IS NULL AND revoked_at IS NULL;
