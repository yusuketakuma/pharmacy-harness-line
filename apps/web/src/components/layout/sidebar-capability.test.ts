import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sidebarSource = () => readFileSync(
  join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'),
  'utf8',
)

describe('pharmacy capability-aware sidebar', () => {
  it('loads account-scoped capability and active-work projections with stale-response guards', () => {
    const source = sidebarSource()
    expect(source).toContain('pharmacyGrowthApi.config(accountId)')
    expect(source).toContain('pharmacyGrowthApi.activeWork(accountId)')
    expect(source).toContain('capabilityRequestRef')
    expect(source).toContain('requestId === capabilityRequestRef.current')
  })

  it('fails closed and marks disabled routes with active work as review-only', () => {
    const source = sidebarSource()
    for (const [path, capability] of [
      ['/prescriptions', 'prescription_intake'],
      ['/myna', 'electronic_prescription'],
      ['/patient-intakes', 'patient_intake'],
      ['/continuity', 'continuity'],
      ['/emergency-contraception', 'emergency_contraception'],
      ['/chats', 'manual_chat'],
      ['/pharmacy-info', 'pharmacy_info'],
    ]) {
      expect(source).toContain(`href: '${path}'`)
      expect(source).toContain(`capability: '${capability}'`)
    }
    expect(source).toContain("item.href === '/staff' && staffRole !== 'owner'")
    expect(source).toContain("item.href === '/accounts' && staffRole === 'staff'")
    expect(source).toContain('利用可否を確認できない')
    expect(source).toContain('再取得')
    expect(source).toContain('確認のみ')
    expect(source).toContain('activeWorkCount > 0')
    expect(source).toContain('capabilityError')
  })
})
