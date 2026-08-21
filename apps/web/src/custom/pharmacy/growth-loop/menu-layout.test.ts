import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('pharmacy admin menu layout', () => {
  it('groups pharmacy-only features by daily work before the general sections', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'),
      'utf8',
    )
    const definition = source.slice(
      source.indexOf('const menuSections ='),
      source.indexOf('function AccountAvatar'),
    )
    const generalStart = definition.indexOf('label: null')
    const groups: Record<string, string[]> = {
      '本日の業務': ['/prescriptions', '/myna', '/emergency-contraception', '/pharmacy-notifications'],
      '患者対応': ['/patient-intakes', '/continuity'],
      '設定': ['/pharmacy-features', '/pharmacy-info', '/pharmacy-growth'],
      'コンプライアンス': ['/privacy-policy', '/data-subject-requests'],
    }
    const sectionStarts = Object.keys(groups).map((label) => definition.indexOf(`label: '${label}',\n    pharmacyOnly: true`))
    expect(sectionStarts.every((position) => position >= 0 && position < generalStart)).toBe(true)
    expect(sectionStarts).toEqual([...sectionStarts].sort((a, b) => a - b))
    Object.entries(groups).forEach(([, paths], index) => {
      const start = sectionStarts[index]
      const end = sectionStarts[index + 1] ?? generalStart
      for (const path of paths) {
        expect(definition.match(new RegExp(`href: '${path}'`, 'g')), path).toHaveLength(1)
        const position = definition.indexOf(`href: '${path}'`)
        expect(position > start && position < end, path).toBe(true)
      }
    })
    expect(source).toContain(
      '.filter((section) => !section.pharmacyOnly || selectedAccount?.pharmacyMode)',
    )
    // Pharmacy tenants are additionally filtered down to the general entries the
    // server allows them; a section left with no entries is dropped rather than
    // rendered as a bare heading.
    expect(source).toContain('isPharmacyMenuPath(item.href)')
    expect(source).toContain('.filter((section) => section.items.length > 0)')
  })
})
