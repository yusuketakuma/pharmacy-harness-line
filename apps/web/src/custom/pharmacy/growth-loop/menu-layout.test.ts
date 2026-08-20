import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('pharmacy admin menu layout', () => {
  it('keeps pharmacy-only features in the first, dedicated section', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'),
      'utf8',
    )
    const definition = source.slice(
      source.indexOf('const menuSections ='),
      source.indexOf('function AccountAvatar'),
    )
    const sectionStart = definition.indexOf("label: '薬局機能'")
    const generalStart = definition.indexOf('label: null')
    expect(sectionStart).toBeGreaterThanOrEqual(0)
    expect(sectionStart).toBeLessThan(generalStart)
    expect(definition.slice(sectionStart, generalStart)).toContain('pharmacyOnly: true')
    expect(source).toContain(
      '.filter((section) => !section.pharmacyOnly || selectedAccount?.pharmacyMode)',
    )
    // Pharmacy tenants are additionally filtered down to the general entries the
    // server allows them; a section left with no entries is dropped rather than
    // rendered as a bare heading.
    expect(source).toContain('isPharmacyMenuPath(item.href)')
    expect(source).toContain('.filter((section) => section.items.length > 0)')

    const paths = [
      '/prescriptions',
      '/emergency-contraception',
      '/pharmacy-notifications',
      '/patient-intakes',
      '/continuity',
      '/myna',
      '/pharmacy-growth',
      '/privacy-policy',
    ]
    const positions = paths.map((path) => definition.indexOf(`href: '${path}'`))
    expect(positions.every((position) => position > sectionStart && position < generalStart)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const path of paths) {
      expect(definition.match(new RegExp(`href: '${path}'`, 'g'))).toHaveLength(1)
    }
  })
})
