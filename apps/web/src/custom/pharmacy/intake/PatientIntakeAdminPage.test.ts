import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPatientListRequestGate, historyStatusLabel } from './PatientIntakeAdminPage'

describe('patient list request gate', () => {
  it('invalidates a manual reload when another account starts loading', () => {
    const gate = createPatientListRequestGate()
    const accountA = gate.start()
    const accountAReload = gate.start()
    const accountB = gate.start()

    expect(accountA.signal.aborted).toBe(true)
    expect(accountAReload.signal.aborted).toBe(true)
    expect(gate.isCurrent(accountAReload)).toBe(false)
    expect(gate.isCurrent(accountB)).toBe(true)
  })

  it('uses the same latest-request gate for patient history and stops loading after failure', () => {
    const page = readFileSync(new URL('./PatientIntakeAdminPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain('historyRequestGate.start()')
    expect(page).toContain('historyRequestGate.isCurrent(request)')
    expect(page).toContain('setHistoryLoading(false)')
    expect(page).toContain('患者情報を表示できません。再度読み込んでください。')
  })

  it('distinguishes list loading and failure from a real empty result', () => {
    const page = readFileSync(new URL('./PatientIntakeAdminPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain('loading && patients.length === 0')
    expect(page).toContain('error && patients.length === 0')
    expect(page).toContain('受付回答')
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
  })
})

describe('patient history labels', () => {
  it('shows next-intake events as patient-readable operations', () => {
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'offered')).toBe('患者の回答待ち')
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'accepted')).toBe('お知らせ登録済み')
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'reminded')).toBe('お知らせ済み')
  })
})
