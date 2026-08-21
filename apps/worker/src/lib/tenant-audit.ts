/**
 * Tenant-side audit trail (tenant_admin_audit_events, custom_048).
 * Shaped like platform-admin/audit.ts: put the statement in the same
 * db.batch as the mutation so the audit row and the write commit together.
 * Detail may carry kinds/counts/ids only — never PHI, passwords, or credentials.
 */
export interface TenantAuditEvent {
  tenantId?: string | null;
  lineAccountId?: string | null;
  actorStaffId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  detail?: Record<string, string | number | boolean | null | string[]>;
}

export function tenantAuditStatement(db: D1Database, event: TenantAuditEvent): D1PreparedStatement {
  if (!event.tenantId && !event.lineAccountId) {
    throw new Error('tenant audit requires a tenant or account scope');
  }
  return db.prepare(
    `INSERT INTO tenant_admin_audit_events
       (id, tenant_id, line_account_id, actor_staff_id, action, resource_type, resource_id,
        detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    event.tenantId ?? null,
    event.lineAccountId ?? null,
    event.actorStaffId,
    event.action,
    event.resourceType ?? null,
    event.resourceId ?? null,
    event.detail ? JSON.stringify(event.detail) : null,
    new Date().toISOString(),
  );
}

/** Standalone insert for reads (PHI views) that have no mutation batch to join. */
export async function recordTenantAudit(db: D1Database, event: TenantAuditEvent): Promise<void> {
  await tenantAuditStatement(db, event).run();
}
