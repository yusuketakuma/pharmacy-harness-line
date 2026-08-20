import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setPatientCapability } from './FeatureSettingsPage'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('pharmacy patient feature settings', () => {
  it('can turn every patient feature off without changing unknown management capabilities', () => {
    expect(setPatientCapability(['pharmacy_dashboard', 'pharmacy_info'], 'pharmacy_info', false))
      .toEqual(['pharmacy_dashboard'])
    expect(setPatientCapability([], 'emergency_contraception', false)).toEqual([])
  })

  it('uses the existing account-scoped config endpoint with CAS and exposes one pharmacy route', () => {
    const page = read('custom/pharmacy/growth-loop/FeatureSettingsPage.tsx')
    const api = read('lib/api.ts')
    const sidebar = read('components/layout/sidebar.tsx')
    const route = read('app/pharmacy-features/page.tsx')

    expect(page).toContain('expectedRevision')
    expect(page).toContain('新しい受付を停止')
    expect(page).toContain('未保存の変更')
    expect(page).toContain('電子処方箋 readiness')
    expect(page).toContain('緊急避妊薬 readiness')
    expect(page).toContain('endpointEvidence')
    expect(page).toContain('対応中 {activeWork?.[key] ?? 0}件')
    expect(api).toContain('saveConfig: (accountId: string')
    expect(api).toContain('readiness: (accountId: string')
    expect(api).toContain('activeWork: (accountId: string')
    expect(sidebar).toContain("href: '/pharmacy-features'")
    expect(route).toContain("FeatureSettingsPage")
  })
})
