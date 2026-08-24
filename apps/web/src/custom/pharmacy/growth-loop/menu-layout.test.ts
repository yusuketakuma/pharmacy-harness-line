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
    const generalStart = definition.indexOf("label: '配信'")
    const groups: Record<string, string[]> = {
      'ホーム': ['/'],
      '日常業務': ['/prescriptions', '/myna', '/emergency-contraception', '/pharmacy-notifications', '/continuity'],
      '患者・法令': ['/patient-intakes', '/chats', '/privacy-policy', '/data-subject-requests'],
      '設定・安全': ['/pharmacy-features', '/pharmacy-info', '/pharmacy-growth'],
    }
    const sectionStarts = Object.keys(groups).map((label) => definition.indexOf(`label: '${label}',`))
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
    expect(source).toContain("!selectedAccount?.pharmacyMode || !('generalOnly' in section)")
    // Pharmacy tenants are additionally filtered down to the general entries the
    // server allows them; a section left with no entries is dropped rather than
    // rendered as a bare heading.
    expect(source).toContain('isPharmacyMenuPath(item.href)')
    expect(source).toContain('.filter((section) => section.items.length > 0)')
  })
})
