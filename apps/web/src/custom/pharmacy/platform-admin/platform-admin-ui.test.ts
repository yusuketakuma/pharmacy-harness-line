import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...segments: string[]) =>
  readFileSync(join(process.cwd(), 'src', ...segments), 'utf8');

describe('platform admin UI contract', () => {
  const api = read('lib', 'platform-admin-api.ts');
  const login = read('app', 'platform-admin', 'login', 'page.tsx');
  const layout = read('app', 'platform-admin', 'layout.tsx');
  const tenantDetail = read('app', 'platform-admin', 'tenants', 'detail', 'page.tsx');
  const shell = read('components', 'app-shell.tsx');

  it('logs in without a pharmacy code — a platform admin login id is global', () => {
    expect(login).toContain('platformAdminApi.login(loginId, password)');
    expect(login).toContain("router.push('/platform-admin/tenants')");
    expect(login).not.toContain('pharmacyCode');
    expect(login).not.toContain('pharmacy-code');
    expect(api).toContain("JSON.stringify({ loginId, password })");
  });

  it('requires a new password before opening the platform admin section', () => {
    expect(login).toContain('mustChangePassword');
    expect(login).toContain('changePassword');
    expect(layout).toContain('res.data.mustChangePassword');
    expect(layout).toContain("router.replace('/platform-admin/login')");
  });

  it('uses platform-admin-only CSRF header and storage keys, never the tenant ones', () => {
    expect(api).toContain("'x-platform-admin-csrf-token'");
    expect(api).toContain("'lh_platform_admin_csrf'");
    expect(api).toContain("'lh_platform_admin_name'");
    const platformSources = [api, login, layout, tenantDetail].join('\n');
    expect(platformSources).not.toContain("'lh_csrf'");
    expect(platformSources).not.toContain('X-CSRF-Token');
    expect(platformSources).not.toContain('lh_staff_name');
  });

  it('edits only displayName and status, and only when they actually changed', () => {
    expect(tenantDetail).toContain('changes.displayName = displayName');
    expect(tenantDetail).toContain('changes.status = status');
    expect(tenantDetail).toContain('if (displayName !== tenant.displayName)');
    expect(tenantDetail).toContain('if (status !== tenant.status)');
    // tenantCode は読み取り専用表示のみ。入力欄も送信もしない。
    expect(tenantDetail).toContain('変更不可');
    expect(tenantDetail).not.toContain('setTenantCode');
    expect(tenantDetail).not.toContain('changes.tenantCode');
    expect(api).toContain('changes: { displayName?: string; status?: string }');
  });

  it('keeps the platform admin section out of the tenant shell', () => {
    expect(shell).toContain("pathname?.startsWith('/platform-admin')");
    const platformPages = [
      login,
      layout,
      tenantDetail,
      read('app', 'platform-admin', 'page.tsx'),
      read('components', 'platform-admin', 'support-mode.tsx'),
      read('app', 'platform-admin', 'tenants', 'page.tsx'),
      read('app', 'platform-admin', 'tenants', 'patients', 'page.tsx'),
      read('app', 'platform-admin', 'tenants', 'patients', 'detail', 'page.tsx'),
      read('app', 'platform-admin', 'logs', 'page.tsx'),
      read('app', 'platform-admin', 'audit', 'page.tsx'),
    ].join('\n');
    expect(platformPages).not.toContain('contexts/account-context');
    expect(platformPages).not.toContain('useAccount(');
    expect(platformPages).not.toContain('layout/sidebar');
    expect(platformPages).not.toContain('auth-guard');
  });

  it('shows an unmissable cross-tenant banner on every page in the section', () => {
    expect(layout).toContain('全体管理者モード');
    expect(layout).toContain('全テナントのデータ');
    for (const label of ['テナント一覧', 'ログ', '自分の操作履歴', 'ログアウト']) {
      expect(layout).toContain(label);
    }
  });

  it('renders the audit trail including a parsed detail_json', () => {
    const audit = read('app', 'platform-admin', 'audit', 'page.tsx');
    expect(audit).toContain('detail_json');
    expect(audit).toContain('JSON.parse(raw)');
    expect(audit).toContain("platformAdminApi.audit({ all, limit: 200 })");
  });
});

/**
 * Tenant Control Center: support mode (期限付きPHIアクセス), the dashboard and
 * the tenant operations panels. Same source-contract style as above — the app
 * has no jsdom, so these assert on what the source is wired to do.
 */
describe('platform admin control center UI contract', () => {
  const api = read('lib', 'platform-admin-api.ts');
  const supportMode = read('components', 'platform-admin', 'support-mode.tsx');
  const layout = read('app', 'platform-admin', 'layout.tsx');
  const dashboard = read('app', 'platform-admin', 'page.tsx');
  const tenantDetail = read('app', 'platform-admin', 'tenants', 'detail', 'page.tsx');
  const patientList = read('app', 'platform-admin', 'tenants', 'patients', 'page.tsx');
  const patientDetail = read('app', 'platform-admin', 'tenants', 'patients', 'detail', 'page.tsx');
  const logs = read('app', 'platform-admin', 'logs', 'page.tsx');

  const uiSources = [
    supportMode, layout, dashboard, tenantDetail, patientList, patientDetail, logs,
  ];

  it('steps up with the current password and keeps it out of storage', () => {
    // The password is a request field and nothing else.
    expect(supportMode).toContain('currentPassword,');
    expect(supportMode).toContain("type=\"password\"");
    expect(supportMode).toContain("setCurrentPassword('')");
    expect(api).toContain('currentPassword: string');
    expect(api).toContain('/support-grants`');

    // No password ever reaches localStorage — check every setItem call in the
    // whole platform-admin UI, not just the form.
    for (const source of [...uiSources, api]) {
      for (const call of source.match(/localStorage\.setItem\([^)]*\)/g) ?? []) {
        expect(call.toLowerCase()).not.toContain('password');
      }
    }
    // ...and it is never put in a URL or a log line either.
    expect(supportMode).not.toMatch(/console\.\w+/);
    expect(supportMode).not.toContain('currentPassword=');
  });

  it('shows a live countdown banner for every active grant on every page', () => {
    expect(layout).toContain('<SupportModeBanner />');
    expect(layout).toContain("@/components/platform-admin/support-mode");
    // The existing cross-tenant banner stays: the countdown is additional.
    expect(layout).toContain('全体管理者モード');

    expect(supportMode).toContain('export function SupportModeBanner');
    expect(supportMode).toContain('platformAdminApi.activeSupportGrants()');
    expect(supportMode).toContain('サポートモード:');
    expect(supportMode).toContain('残り');
    expect(supportMode).toContain('grant.expires_at');
    expect(supportMode).toContain('setInterval');
    // 終了 button ends exactly that grant.
    expect(supportMode).toContain('platformAdminApi.endSupportGrant(grantId)');
    expect(supportMode).toContain('終了');
  });

  it('treats a 403 from the PHI routes as "start support mode", not a generic error', () => {
    // 403 is the only status those routes use for a missing grant.
    expect(api).toContain('export function isSupportModeRequired');
    expect(api).toContain('error.status === 403');
    for (const page of [patientList, patientDetail]) {
      expect(page).toContain('isSupportModeRequired(caught)');
      expect(page).toContain('setGrantMissing(true)');
      expect(page).toContain('else setError(caught.message)');
      expect(page).toContain('<SupportModeRequired');
    }
    expect(supportMode).toContain('このテナントの患者情報を見るにはサポートモードを開始してください');
  });

  it('confirms before disabling a staff member, and before revoking every session', () => {
    const confirmAt = tenantDetail.indexOf('window.confirm');
    const disableAt = tenantDetail.indexOf('platformAdminApi.disableStaff(');
    expect(confirmAt).toBeGreaterThan(-1);
    expect(disableAt).toBeGreaterThan(confirmAt);
    // Early return on cancel, so the API call is genuinely gated.
    expect(tenantDetail).toContain('if (!window.confirm(');
    expect(tenantDetail).toContain('platformAdminApi.revokeTenantSessions(tenantId)');
  });

  it('renders the dashboard counters and all five integrity checks', () => {
    expect(dashboard).toContain('platformAdminApi.dashboard()');
    expect(dashboard).toContain('platformAdminApi.integrity()');
    for (const key of [
      'totalTenants', 'activeTenants', 'suspendedTenants', 'webhookFailures24h',
      'webhookPending', 'activeSupportGrants', 'tenantsWithStaleActivity',
    ]) {
      expect(dashboard).toContain(key);
    }
    for (const check of [
      'orphaned_tenant_line_accounts', 'missing_capability_row',
      'patients_without_active_account_mapping', 'stale_pending_webhook_events',
      'dangling_source_handoff',
    ]) {
      expect(dashboard).toContain(check);
    }
    expect(layout).toContain("{ href: '/platform-admin', label: 'ダッシュボード' }");
  });

  it('wires health, LINE diagnostics and the outbound pause into the tenant page', () => {
    expect(tenantDetail).toContain('platformAdminApi.tenantHealth(tenantId)');
    expect(tenantDetail).toContain('platformAdminApi.lineStatus(tenantId)');
    expect(tenantDetail).toContain('platformAdminApi.staff(tenantId)');
    expect(tenantDetail).toContain('platformAdminApi.testLineConnection(tenantId, lineAccountId)');
    expect(tenantDetail).toContain('platformAdminApi.setOutboundMessaging(tenantId, paused)');
    // A failed probe is a 200 with ok:false, so it must render inline, not as an error.
    expect(tenantDetail).toContain('probe.ok ?');
    // No secret-bearing field is ever displayed; the API only exposes presence booleans.
    expect(api).toContain('hasEncryptedCredential: boolean');
    expect(api).not.toMatch(/channelSecret|accessToken/);
  });

  it('offers webhook retry only for failed or dead-lettered rows', () => {
    expect(logs).toContain("row.status === 'failed' || Boolean(row.dead_lettered_at)");
    expect(logs).toContain('platformAdminApi.retryWebhookEvent(rowTenantId, webhookEventId)');
    // No tenant to scope the retry to means no button.
    expect(logs).toContain('if (!retryable || !rowTenantId || !webhookEventId) return null');
    expect(logs).toContain('再試行');
  });

  it('routes every call through the shared authenticated client', () => {
    // platformAdminFetch is the only place a raw fetch() may appear: it is what
    // attaches credentials and the platform-admin CSRF header.
    for (const source of uiSources) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).toMatch(/@\/lib\/platform-admin-api|@\/components\/platform-admin/);
    }
    expect((api.match(/\bfetch\s*\(/g) ?? []).length).toBe(1);
    expect(api).toContain("credentials: 'include'");

    // Every new endpoint is a typed wrapper, and every id is escaped.
    for (const method of [
      'startSupportGrant', 'endSupportGrant', 'activeSupportGrants', 'dashboard',
      'tenantHealth', 'integrity', 'staff', 'disableStaff', 'revokeTenantSessions',
      'lineStatus', 'testLineConnection', 'setOutboundMessaging', 'retryWebhookEvent',
    ]) {
      expect(api).toContain(`${method}:`);
    }
    // Every value interpolated as its own path segment (i.e. right after a "/")
    // must be escaped, or an id containing "/" or "?" would rewrite the route.
    const pathSegments = api.match(/\/\$\{[^}]+\}/g) ?? [];
    expect(pathSegments.length).toBeGreaterThan(5);
    for (const segment of pathSegments) {
      expect(segment).toContain('encodeURIComponent');
    }
  });

  it('parses the grant scopes column rather than assuming it is an array', () => {
    // access-grant.ts stores scopes as JSON text and returns the row verbatim.
    expect(api).toContain('scopes: string');
    expect(api).toContain('export function grantScopes');
    expect(api).toContain('JSON.parse(grant.scopes)');
  });
});
