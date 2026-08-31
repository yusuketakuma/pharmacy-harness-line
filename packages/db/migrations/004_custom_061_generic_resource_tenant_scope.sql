-- Tenant ownership for generic resources enabled through a tenant session.
-- Ambiguous legacy rows remain NULL and are visible only to the legacy-global scope.
ALTER TABLE message_templates
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE entry_routes
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE forms
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE traffic_pools
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE google_calendar_connections
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE templates
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX idx_message_templates_tenant_name
  ON message_templates(tenant_id, name);

CREATE INDEX idx_entry_routes_tenant_created
  ON entry_routes(tenant_id, created_at DESC);

CREATE INDEX idx_forms_tenant_created
  ON forms(tenant_id, created_at DESC);

CREATE INDEX idx_traffic_pools_tenant_created
  ON traffic_pools(tenant_id, created_at DESC);

CREATE INDEX idx_google_calendar_connections_tenant_created
  ON google_calendar_connections(tenant_id, created_at DESC);

CREATE INDEX idx_templates_tenant_category_created
  ON templates(tenant_id, category, created_at DESC);

CREATE TRIGGER auto_replies_template_scope_insert
BEFORE INSERT ON auto_replies
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'AUTO_REPLY_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER auto_replies_template_scope_update
BEFORE UPDATE OF template_id, line_account_id ON auto_replies
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'AUTO_REPLY_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER scenario_steps_template_scope_insert
BEFORE INSERT ON scenario_steps
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    INNER JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS scenario.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'SCENARIO_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER scenario_steps_template_scope_update
BEFORE UPDATE OF scenario_id, template_id ON scenario_steps
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM templates AS template
    INNER JOIN scenarios AS scenario ON scenario.id = NEW.scenario_id
   WHERE template.id = NEW.template_id
     AND template.tenant_id IS scenario.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'SCENARIO_TEMPLATE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER form_submissions_tenant_scope_insert
BEFORE INSERT ON form_submissions
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM forms AS form
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE form.id = NEW.form_id
     AND form.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FORM_SUBMISSION_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER traffic_pools_account_scope_insert
BEFORE INSERT ON traffic_pools
WHEN (NEW.tenant_id IS NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER traffic_pools_account_scope_update
BEFORE UPDATE OF tenant_id, active_account_id ON traffic_pools
WHEN (NEW.tenant_id IS NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.active_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER pool_accounts_tenant_scope_insert
BEFORE INSERT ON pool_accounts
WHEN NOT EXISTS (
  SELECT 1
    FROM traffic_pools AS pool
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE pool.id = NEW.pool_id
     AND pool.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER pool_accounts_tenant_scope_update
BEFORE UPDATE OF pool_id, line_account_id ON pool_accounts
WHEN NOT EXISTS (
  SELECT 1
    FROM traffic_pools AS pool
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = NEW.line_account_id
   WHERE pool.id = NEW.pool_id
     AND pool.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'TRAFFIC_POOL_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER form_submissions_tenant_scope_update
BEFORE UPDATE OF form_id, friend_id ON form_submissions
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM forms AS form
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
    LEFT JOIN tenant_line_accounts AS mapping
      ON mapping.line_account_id = friend.line_account_id
   WHERE form.id = NEW.form_id
     AND form.tenant_id IS mapping.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'FORM_SUBMISSION_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER google_calendar_connections_account_scope_insert
BEFORE INSERT ON google_calendar_connections
WHEN (NEW.tenant_id IS NULL AND NEW.line_account_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts WHERE line_account_id = NEW.line_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.line_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'CALENDAR_CONNECTION_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER google_calendar_connections_account_scope_update
BEFORE UPDATE OF tenant_id, line_account_id ON google_calendar_connections
WHEN (NEW.tenant_id IS NULL AND NEW.line_account_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tenant_line_accounts WHERE line_account_id = NEW.line_account_id
      ))
  OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant_line_accounts
         WHERE line_account_id = NEW.line_account_id AND tenant_id = NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'CALENDAR_CONNECTION_ACCOUNT_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER calendar_bookings_account_scope_insert
BEFORE INSERT ON calendar_bookings
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM google_calendar_connections AS connection
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
   WHERE connection.id = NEW.connection_id
     AND connection.line_account_id IS friend.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'CALENDAR_BOOKING_ACCOUNT_SCOPE_MISMATCH'); END;

CREATE TRIGGER entry_routes_resource_scope_insert
BEFORE INSERT ON entry_routes
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios WHERE id = NEW.scenario_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.pool_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM traffic_pools WHERE id = NEW.pool_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates
         WHERE id = NEW.intro_template_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'ENTRY_ROUTE_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER entry_routes_resource_scope_update
BEFORE UPDATE OF tenant_id, tag_id, scenario_id, pool_id, intro_template_id ON entry_routes
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios WHERE id = NEW.scenario_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.pool_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM traffic_pools WHERE id = NEW.pool_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates
         WHERE id = NEW.intro_template_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'ENTRY_ROUTE_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER forms_resource_scope_insert
BEFORE INSERT ON forms
WHEN (NEW.on_submit_tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.on_submit_tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.on_submit_scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios
         WHERE id = NEW.on_submit_scenario_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'FORM_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER forms_resource_scope_update
BEFORE UPDATE OF tenant_id, on_submit_tag_id, on_submit_scenario_id ON forms
WHEN (NEW.on_submit_tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags WHERE id = NEW.on_submit_tag_id AND tenant_id IS NEW.tenant_id
      ))
  OR (NEW.on_submit_scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios
         WHERE id = NEW.on_submit_scenario_id AND tenant_id IS NEW.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'FORM_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER tracked_links_resource_scope_insert
BEFORE INSERT ON tracked_links
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.tag_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.scenario_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.intro_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.reward_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.reward_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRACKED_LINK_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER tracked_links_resource_scope_update
BEFORE UPDATE OF line_account_id, tag_id, scenario_id, intro_template_id, reward_template_id
ON tracked_links
WHEN (NEW.tag_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tags AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.tag_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.scenario_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scenarios AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.scenario_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.intro_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.intro_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
  OR (NEW.reward_template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM message_templates AS resource
        LEFT JOIN tenant_line_accounts AS mapping
          ON mapping.line_account_id = NEW.line_account_id
        WHERE resource.id = NEW.reward_template_id AND resource.tenant_id IS mapping.tenant_id
      ))
BEGIN SELECT RAISE(ABORT, 'TRACKED_LINK_RESOURCE_TENANT_SCOPE_MISMATCH'); END;

CREATE TRIGGER calendar_bookings_account_scope_update
BEFORE UPDATE OF connection_id, friend_id ON calendar_bookings
WHEN NEW.friend_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM google_calendar_connections AS connection
    INNER JOIN friends AS friend ON friend.id = NEW.friend_id
   WHERE connection.id = NEW.connection_id
     AND connection.line_account_id IS friend.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'CALENDAR_BOOKING_ACCOUNT_SCOPE_MISMATCH'); END;
