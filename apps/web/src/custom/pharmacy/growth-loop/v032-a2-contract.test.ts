import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FLOWS = [
  ['処方せん', join('src', 'custom', 'pharmacy', 'prescriptions', 'PrescriptionQueuePage.tsx')],
  ['電子処方箋', join('src', 'custom', 'pharmacy', 'myna', 'MynaAdminPage.tsx')],
  ['緊急避妊薬', join('src', 'custom', 'pharmacy', 'emergency-contraception', 'EmergencyContraceptionAdminPage.tsx')],
  ['服薬フォロー', join('src', 'custom', 'pharmacy', 'medication-followup', 'MedicationFollowUpPanel.tsx')],
  ['継続フォロー', join('src', 'custom', 'pharmacy', 'continuity', 'ContinuityAdminPage.tsx')],
  ['個別チャット', join('src', 'app', 'chats', 'page.tsx')],
] as const

describe('V032-A2 cross-domain action contract', () => {
  it('keeps every existing flow account-scoped, confirmable, guarded, and recoverable', () => {
    for (const [name, relativePath] of FLOWS) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8')
      expect(source, name).toMatch(/selectedAccountId|accountId/)
      expect(source, name).toContain('setError')
      expect(source, name).toContain('disabled=')
      expect(source, name).toMatch(/window\.confirm|sendLockRef/)
      expect(source, name).toMatch(/requestGate|version|再読み込み|sendLockRef/)
    }
  })
})
