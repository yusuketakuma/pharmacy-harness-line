import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verificationConfirmationMessage, verificationOptionsForHandoffStatus } from './MynaAdminPage.js'

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
})
