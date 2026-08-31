CREATE TRIGGER ref_tracking_entry_route_tenant_scope_insert
BEFORE INSERT ON ref_tracking
WHEN NEW.entry_route_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM entry_routes AS route
    LEFT JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE route.id = NEW.entry_route_id
     AND route.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'REF_TRACKING_ENTRY_ROUTE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER ref_tracking_entry_route_tenant_scope_update
BEFORE UPDATE OF entry_route_id, friend_id ON ref_tracking
WHEN NEW.entry_route_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM entry_routes AS route
    LEFT JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE route.id = NEW.entry_route_id
     AND route.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'REF_TRACKING_ENTRY_ROUTE_TENANT_SCOPE_MISMATCH'); END;
