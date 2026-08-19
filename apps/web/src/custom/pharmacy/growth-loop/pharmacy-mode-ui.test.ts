import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('pharmacy mode UI boundary', () => {
  it('uses the pharmacy dashboard instead of generic growth APIs', () => {
    const dashboard = read('app/page.tsx')

    expect(dashboard).toContain("import GrowthDashboardPage from '@/custom/pharmacy/growth-loop/GrowthDashboardPage'")
    expect(dashboard).toContain('if (selectedAccount?.pharmacyMode) return <GrowthDashboardPage />')
  })

  it('does not render generic global link settings for a pharmacy tenant', () => {
    const accounts = read('app/accounts/page.tsx')

    expect(accounts).toContain('pharmacyMode: boolean')
    expect(accounts).toContain('!accounts.some((account) => account.pharmacyMode) &&')
  })
})
