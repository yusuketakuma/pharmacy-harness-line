import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('provisioned tenant login UI', () => {
  const login = readFileSync(join(process.cwd(), 'src', 'app', 'login', 'page.tsx'), 'utf8');
  const guard = readFileSync(join(process.cwd(), 'src', 'components', 'auth-guard.tsx'), 'utf8');
  const staff = readFileSync(join(process.cwd(), 'src', 'app', 'staff', 'page.tsx'), 'utf8');

  it('uses pharmacy code, administrator ID, and password by default', () => {
    expect(login).toContain('JSON.stringify({ loginId, password, pharmacyCode })');
    expect(login).toContain('管理者ID');
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

  it('issues staff login IDs and temporary passwords instead of API keys', () => {
    expect(staff).toContain('loginId');
    expect(staff).toContain('temporaryPassword');
    expect(staff).toContain('/reset-password');
    expect(staff).not.toContain('regenerate-key');
    expect(staff).not.toContain('APIキー');
  });
});
