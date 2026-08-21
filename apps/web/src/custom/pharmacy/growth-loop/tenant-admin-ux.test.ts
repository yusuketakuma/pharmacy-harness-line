import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('tenant admin UX quick wins', () => {
  it('UX-01: an expired session returns staff to the page they were on', () => {
    const api = read('lib/api.ts')
    const guard = read('components/auth-guard.tsx')
    const login = read('app/login/page.tsx')
    expect(api).toContain("import { loginRedirectPath } from './safe-next-path'")
    expect(api).toContain("window.location.assign(loginRedirectPath('expired'))")
    expect(guard).toContain("router.replace(loginRedirectPath())")
    expect(login).toContain("safeNextPath(")
    expect(login).toContain("reason') === 'expired'")
    expect(login).toContain('セッションの有効期限が切れました。もう一度ログインしてください')
  })

  it('UX-09: login explains temporary-password reissue and a 403', () => {
    const login = read('app/login/page.tsx')
    expect(login).toContain('res.status === 403')
    expect(login).toContain('このアカウントは無効化されています。薬局のオーナーにご確認ください')
    expect(login).toContain('パスワードを忘れた場合は、薬局のオーナーまたは管理者に仮パスワードの再発行を依頼してください')
  })

  it('UX-05: the CC prompt button is not rendered for a pharmacy tenant', () => {
    const button = read('components/cc-prompt-button.tsx')
    expect(button).toContain("import { useAccount } from '@/contexts/account-context'")
    expect(button).toContain('if (selectedAccount?.pharmacyMode) return null')
  })

  it('UX-03: sidebar labels and page headings use the same words', () => {
    const sidebar = read('components/layout/sidebar.tsx')
    const pages: Record<string, string> = {
      '/prescriptions': 'custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx',
      '/emergency-contraception': 'custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx',
      '/patient-intakes': 'custom/pharmacy/intake/PatientIntakeAdminPage.tsx',
      '/myna': 'custom/pharmacy/myna/MynaAdminPage.tsx',
      '/pharmacy-growth': 'custom/pharmacy/growth-loop/GrowthDashboardPage.tsx',
      '/data-subject-requests': 'custom/pharmacy/data-subject-requests/DataSubjectRequestAdminPage.tsx',
      '/pharmacy-features': 'custom/pharmacy/growth-loop/FeatureSettingsPage.tsx',
      '/continuity': 'custom/pharmacy/continuity/ContinuityAdminPage.tsx',
      '/pharmacy-notifications': 'custom/pharmacy/activity-notifications/PharmacyActivityNotificationsPage.tsx',
    }
    for (const [href, file] of Object.entries(pages)) {
      const label = sidebar.match(new RegExp(`href: '${href}', label: '([^']+)'`))?.[1]
      expect(label, href).toBeTruthy()
      expect(read(file), href).toMatch(new RegExp(`<h1[^>]*>${label}</h1>`))
    }
  })

  it('UX-03: the dashboard reuses the prescription status labels', () => {
    const summary = read('custom/pharmacy/growth-loop/TodayOperationsSummary.tsx')
    expect(summary).toContain("import { PRESCRIPTION_STATUS_LABELS } from '@/custom/pharmacy/prescriptions/PrescriptionQueueOverview'")
    expect(summary).toContain('...PRESCRIPTION_STATUS_LABELS,')
  })

  it('UX-04: emergency contraception hides internal revision/version counters and English status words', () => {
    const page = read('custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx')
    expect(page).not.toContain('Phase 1 管理')
    expect(page).not.toContain('/ revision {')
    expect(page).not.toContain('/ version {')
    expect(page).not.toContain('readiness 設定')
    const features = read('custom/pharmacy/growth-loop/FeatureSettingsPage.tsx')
    expect(features).toContain('readinessStatusLabel(readiness.electronicPrescription.status)')
    expect(features).toContain('readinessStatusLabel(readiness.richMenu.syncStatus)')
    expect(features).not.toContain('Human Gate')
    expect(features).not.toContain('read-back')
  })

  it('UX-08: staff mutations are serialized, confirmed, and clipboard failures are shown', () => {
    const staff = read('app/staff/page.tsx')
    expect(staff).toContain('const [mutatingId, setMutatingId] = useState<string | null>(null)')
    expect(staff).toContain('disabled={mutatingId !== null}')
    expect(staff).toContain('を無効化しますか？')
    expect(staff).toContain('コピーできませんでした。表示された仮パスワードを手で控えてください')
  })

  it('UX-10: the follow-up card deep-links to the attention view of the intake page', () => {
    const summary = read('custom/pharmacy/growth-loop/TodayOperationsSummary.tsx')
    const intake = read('custom/pharmacy/intake/PatientIntakeAdminPage.tsx')
    expect(summary).toContain("{ key: 'medicationFollowup', label: '服薬フォロー', href: '/patient-intakes?followup=attention' }")
    expect(intake).toContain(".get('followup') === 'attention'")
    expect(intake).toContain('服薬フォローの要対応を確認します。患者を選ぶと「服薬フォロー」欄まで移動します。')
    expect(intake).toContain("document.getElementById('medication-followup-title')?.scrollIntoView(")
  })
})
