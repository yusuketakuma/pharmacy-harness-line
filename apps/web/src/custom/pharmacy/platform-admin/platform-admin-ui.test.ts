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
