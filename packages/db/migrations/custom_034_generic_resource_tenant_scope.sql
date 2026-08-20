-- Tenant ownership for generic admin resources that were previously global.
-- Ambiguous legacy rows stay NULL and are hidden from tenant sessions.
ALTER TABLE tags ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE incoming_webhooks ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE outgoing_webhooks ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

UPDATE tags
   SET tenant_id = (SELECT id FROM tenants)
 WHERE tenant_id IS NULL
   AND (SELECT COUNT(*) FROM tenants) = 1;

UPDATE incoming_webhooks
   SET tenant_id = (SELECT id FROM tenants)
 WHERE tenant_id IS NULL
   AND (SELECT COUNT(*) FROM tenants) = 1;

UPDATE outgoing_webhooks
   SET tenant_id = (SELECT id FROM tenants)
 WHERE tenant_id IS NULL
   AND (SELECT COUNT(*) FROM tenants) = 1;

CREATE INDEX IF NOT EXISTS idx_tags_tenant_name
  ON tags(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_tenant_created
  ON incoming_webhooks(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_tenant_created
  ON outgoing_webhooks(tenant_id, created_at DESC);
