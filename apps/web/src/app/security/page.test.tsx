import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionSecurityView } from '../../custom/pharmacy/provisioning/session-security'

describe('session security UI', () => {
  it('shows current and other sessions without exposing server session identifiers', () => {
    const html = renderToStaticMarkup(<SessionSecurityView
      sessions={[
        {
          current: true,
          sessionKind: 'standard',
          createdAt: '2026-08-30T00:00:00.000Z',
          expiresAt: '2026-09-06T00:00:00.000Z',
        },
        {
          current: false,
          sessionKind: 'standard',
          createdAt: '2026-08-29T00:00:00.000Z',
          expiresAt: '2026-09-05T00:00:00.000Z',
        },
      ]}
      loading={false}
      error=""
      message=""
      currentPassword=""
      busy={false}
      onPasswordChange={vi.fn()}
      onRevoke={vi.fn()}
    />)

    expect(html).toContain('ログイン中の端末')
    expect(html).toContain('この端末')
    expect(html).toContain('他の端末')
    expect(html).toContain('現在のパスワード')
    expect(html).not.toContain('tokenHash')
  })

  it('uses the password-session endpoints and sends only the re-authentication secret', () => {
    const source = readFileSync(new URL('../../custom/pharmacy/provisioning/session-security.tsx', import.meta.url), 'utf8')
    const entry = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

    expect(source).toContain("fetchApi<SessionListResponse>('/api/auth/sessions')")
    expect(source).toContain("'/api/auth/sessions/revoke-others'")
    expect(source).toContain('JSON.stringify({ currentPassword })')
    expect(source).not.toContain('tokenHash')
    expect(entry).toContain("@/custom/pharmacy/provisioning/session-security")
  })
})
