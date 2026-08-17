import { describe, expect, it } from 'vitest'
import { createPatientListRequestGate } from './PatientIntakeAdminPage'

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
