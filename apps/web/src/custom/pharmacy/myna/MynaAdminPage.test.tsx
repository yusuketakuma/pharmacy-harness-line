import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createRequestGate, verificationConfirmationMessage, verificationOptionsForHandoffStatus } from './MynaAdminPage.js'

describe('Myna admin safety', () => {
  it('explains that a verification result is final before recording it', () => {
    const message = verificationConfirmationMessage('電子処方箋を確認した')

    expect(message).toContain('電子処方箋を確認した')
    expect(message).toContain('変更できません')
  })

  it('does not show an empty queue while the first request is loading', () => {
    const page = readFileSync(new URL('./MynaAdminPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain("loading && handoffs.length === 0 ? <p")
    expect(page).toContain('確認キューを読み込み中…')
    expect(page).toContain('error && handoffs.length === 0')
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
    expect(page).toContain('使用期限:')
    expect(page).toContain('min-h-11')
  })

  it('lets staff formally record an expired handoff as prescription expired', () => {
    expect(verificationOptionsForHandoffStatus('EXPIRED')).toEqual([
      ['PRESCRIPTION_EXPIRED', '使用期限外'],
    ])
    expect(verificationOptionsForHandoffStatus('CLOSED')).toEqual([])
  })

  it('labels the electronic queue, filters status, and opens detail before linking the shadow submission', () => {
    const page = readFileSync(new URL('./MynaAdminPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain('電子処方箋受付')
    expect(page).toContain('mynaAdminApi.list(accountId, statusFilter)')
    expect(page).toContain('mynaAdminApi.detail(accountId, handoffId)')
    expect(page).toContain('/prescriptions?submission=')
    expect(page).toContain('患者申告時刻')
  })

  it('discards stale responses and clears endpoint drafts when the account changes', () => {
    const gate = createRequestGate()
    const first = gate.start()
    const second = gate.start()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    gate.abort()
    expect(gate.isCurrent(second)).toBe(false)

    const page = readFileSync(new URL('./MynaAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('selectedAccountRef.current !== accountId')
    expect(page).toContain("setEndpoint({ tenantAlias: '', endpointUrl: '', enabled: true })")
    expect(page).toContain("setEndpointMasked('')")
  })

  it('can disable or re-enable the saved endpoint without re-entering its secret URL', () => {
    const page = readFileSync(new URL('./MynaAdminPage.tsx', import.meta.url), 'utf8')
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

    expect(page).toContain('mynaAdminApi.setEndpointEnabled')
    expect(page).toContain('endpointConfig.revision')
    expect(page).toContain('電子処方箋連携を利用する')
    expect(api).toContain("method: 'PATCH'")
  })

  it('records explicit official-console verification without exposing the URL', () => {
    const page = readFileSync(new URL('./MynaAdminPage.tsx', import.meta.url), 'utf8')
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

    expect(page).toContain('mynaAdminApi.verifyEndpoint')
    expect(page).toContain('endpointConfig.revision')
    expect(page).toContain('公式画面で動作確認済みとして記録')
    expect(api).toContain('/myna-endpoint/verification?')
  })
})
