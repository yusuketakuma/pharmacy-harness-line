import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  pharmacyCandidateChangeLabel,
  setPatientCapability,
  shouldOfferRichMenuCandidate,
} from './FeatureSettingsPage'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('pharmacy patient feature settings', () => {
  it('can turn every patient feature off without changing unknown management capabilities', () => {
    expect(setPatientCapability(['pharmacy_dashboard', 'pharmacy_info'], 'pharmacy_info', false))
      .toEqual(['pharmacy_dashboard'])
    expect(setPatientCapability([], 'emergency_contraception', false)).toEqual([])
    expect(shouldOfferRichMenuCandidate(['pharmacy_rich_menu'])).toBe(true)
    expect(shouldOfferRichMenuCandidate(['pharmacy_info'])).toBe(false)
  })

  it('announces OFF removal, ON addition, and movement as different candidate changes', () => {
    expect(pharmacyCandidateChangeLabel({ kind: 'removed', currentIndex: 1, draftIndex: null }))
      .toBe('公開中の枠2を候補から削除します。OFFにした機能の画像とtap actionが公開中に残っています。')
    expect(pharmacyCandidateChangeLabel({ kind: 'added', currentIndex: null, draftIndex: 0 }))
      .toBe('候補の枠1を追加します。ONにした機能は公開中メニューへまだ反映されていません。')
    expect(pharmacyCandidateChangeLabel({ kind: 'moved', currentIndex: 2, draftIndex: 0 }))
      .toBe('公開中の枠3を候補の枠1へ移動します。')
  })

  it('uses the existing account-scoped config endpoint with CAS and exposes one pharmacy route', () => {
    const page = read('custom/pharmacy/growth-loop/FeatureSettingsPage.tsx')
    const api = read('lib/api.ts')
    const sidebar = read('components/layout/sidebar.tsx')
    const route = read('app/pharmacy-features/page.tsx')

    expect(page).toContain('expectedRevision')
    expect(page).toContain('新しい受付を停止')
    expect(page).toContain('未保存の変更')
    expect(page).toContain('電子処方箋の受付条件')
    expect(page).toContain('緊急避妊薬の受付条件')
    expect(page).toContain('リッチメニュー同期')
    expect(page).toContain('readiness.richMenu.syncStatus')
    expect(page).toContain('endpointEvidence')
    expect(page).toContain('設定診断')
    expect(page).toContain('configurationDoctor.checks')
    expect(page).toContain('check.impact')
    expect(page).toContain('check.fixHref')
    expect(page).toContain('対応中 {activeWork?.[key] ?? 0}件')
    expect(page).toContain('月間自動通知上限')
    expect(page).toContain('proactiveMonthlyLimit: monthlyLimit')
    expect(page).toContain('min={0}')
    expect(page).toContain('max={100}')
    expect(page).toContain('リッチメニュー候補画像を確認')
    expect(page).toContain('新しい配置を作成')
    expect(page).toContain('href="/rich-menus#pharmacy-rich-menu-layout-editor"')
    expect(page).not.toContain('/rich-menus?candidate=1')
    expect(page).toContain('電子処方箋・緊急避妊薬などは「すべての機能」から開けます。')
    expect(page).toContain('aria-live="polite"')
    expect(page).toContain('pharmacyCandidateImageUrl')
    expect(page).not.toContain('api.richMenuGroups.createPharmacyVersion')
    expect(page).not.toContain('initialMode="set-default"')
    expect(api).toContain('saveConfig: (accountId: string')
    expect(api).toContain('pharmacyCandidate: (accountId: string)')
    expect(api).toContain('/api/custom/pharmacy/rich-menus/candidate?accountId=')
    expect(api).toContain('/api/custom/pharmacy/rich-menus/candidate/image?')
    expect(api).toContain('readiness: (accountId: string')
    expect(api).toContain('configurationDoctor: {')
    expect(api).toContain('activeWork: (accountId: string')
    expect(sidebar).toContain("href: '/pharmacy-features'")
    expect(route).toContain("FeatureSettingsPage")
  })
})
