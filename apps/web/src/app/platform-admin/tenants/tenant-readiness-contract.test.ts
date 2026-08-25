import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pageSource = () => readFileSync(
  join(process.cwd(), 'src', 'app', 'platform-admin', 'tenants', 'page.tsx'),
  'utf8',
)

describe('platform tenant readiness projection', () => {
  it('joins the existing tenant and dashboard projections without exposing tenant IDs', () => {
    const source = pageSource()
    expect(source).toContain('platformAdminApi.tenants()')
    expect(source).toContain('platformAdminApi.dashboard()')
    expect(source).toContain('Promise.allSettled')
    expect(source).toContain('pharmacyReadiness.tenants')
    expect(source).toContain('UNVERIFIED')
    expect(source).toContain('最終確認')
    expect(source).toContain('設定を修正')
    expect(source).not.toContain('<td className="px-3 py-2 font-mono">{tenant.id}</td>')
  })
})
