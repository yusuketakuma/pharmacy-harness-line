/**
 * Records one cross-tenant access by a platform admin. Every read or write
 * a /api/platform-admin/* route performs on tenant data must call this —
 * it is the entire compliance justification for letting this role bypass
 * tenant boundaries. Never let a route return data or apply a write without
 * having called this first (or in the same batch as the write, for
 * mutations — see recordPlatformAdminAccessBatched).
 */
export async function recordPlatformAdminAccess(
  db: D1Database,
  platformAdminId: string,
  tenantId: string | null,
  action: string,
  resourceType?: string,
  resourceId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.prepare(
    `INSERT INTO platform_admin_access_events
       (id, platform_admin_id, tenant_id, action, resource_type, resource_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    platformAdminId,
    tenantId,
    action,
    resourceType ?? null,
    resourceId ?? null,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString(),
  ).run();
}

/** Same insert, shaped for db.batch() alongside a mutation so the audit row and the write commit together. */
export function platformAdminAccessStatement(
  db: D1Database,
  platformAdminId: string,
  tenantId: string | null,
  action: string,
  resourceType?: string,
  resourceId?: string,
  detail?: Record<string, unknown>,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO platform_admin_access_events
       (id, platform_admin_id, tenant_id, action, resource_type, resource_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    platformAdminId,
    tenantId,
    action,
    resourceType ?? null,
    resourceId ?? null,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString(),
  );
}
