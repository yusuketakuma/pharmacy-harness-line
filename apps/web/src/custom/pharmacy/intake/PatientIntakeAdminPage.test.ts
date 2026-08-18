import { describe, expect, it } from 'vitest'
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
})

describe('patient history labels', () => {
  it('shows next-intake events as patient-readable operations', () => {
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'offered')).toBe('患者の回答待ち')
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'accepted')).toBe('お知らせ登録済み')
    expect(historyStatusLabel('次回事前送信のお知らせを更新', 'reminded')).toBe('お知らせ済み')
  })
})
