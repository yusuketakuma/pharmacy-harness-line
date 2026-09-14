import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('provisioned tenant login UI', () => {
  const login = readFileSync(join(process.cwd(), 'src', 'app', 'login', 'page.tsx'), 'utf8');
  const platformLogin = readFileSync(
    join(process.cwd(), 'src', 'app', 'platform-admin', 'login', 'page.tsx'),
    'utf8',
  );
  const guard = readFileSync(join(process.cwd(), 'src', 'components', 'auth-guard.tsx'), 'utf8');
  const staffApi = readFileSync(join(process.cwd(), '..', 'worker', 'src', 'routes', 'admin', 'staff.ts'), 'utf8');

  it('uses only pharmacy code and password by default', () => {
    expect(login).toContain('JSON.stringify({ pharmacyCode, password })');
    expect(login).toContain('薬局コード');
    expect(login).not.toContain('loginId');
    expect(login).not.toContain('管理者ID');
    expect(login).not.toContain('従来のAPIキーでログイン');
    expect(login).not.toContain('JSON.stringify({ apiKey, pharmacyCode })');
    expect(`${login}\n${guard}\n${readFileSync(join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'), 'utf8')}`)
      .not.toContain('lh_api_key');
  });

  it('requires a new password before opening the dashboard', () => {
    expect(login).toContain('loginData?.data?.mustChangePassword');
    expect(login).toContain('/api/auth/change-password');
    expect(login).toContain('currentPassword');
    expect(login).toContain('newPassword');
    expect(guard).toContain('data.data.mustChangePassword');
    expect(guard).toContain("router.replace('/login')");
  });

  it('uses the approved 15 to 128 character policy in every password UI', () => {
    for (const source of [login, platformLogin]) {
      expect(source).not.toContain('12文字以上128文字以下');
      expect(source).not.toContain('minLength={12}');
    }
    expect(login).toContain('const passwordLength = [...newPassword].length');
    expect(login).toContain('passwordLength < 15');
    expect(platformLogin).toContain('const passwordLength = [...newPassword].length');
    expect(platformLogin).toContain('passwordLength < 15');
    expect(`${login}\n${platformLogin}`).toContain('よく使われるパスワード');
  });

  it('does not expose owner-only staff controls to the shared admin flow', () => {
    expect(readFileSync(join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'), 'utf8'))
      .toContain("item.href === '/staff' && staffRole !== 'owner'");
    expect(staffApi).toContain("requireRole('owner')");
  });
});
