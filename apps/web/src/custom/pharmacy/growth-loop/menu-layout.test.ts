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
    expect(source).not.toContain('isPharmacyMenuPath')
    expect(source).not.toContain('selectedAccount?.pharmacyMode && !')

    const paths = [
      '/prescriptions',
      '/pharmacy-notifications',
      '/patient-intakes',
      '/continuity',
      '/myna',
      '/pharmacy-growth',
    ]
    const positions = paths.map((path) => definition.indexOf(`href: '${path}'`))
    expect(positions.every((position) => position > sectionStart && position < generalStart)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const path of paths) {
      expect(definition.match(new RegExp(`href: '${path}'`, 'g'))).toHaveLength(1)
    }
  })
})
