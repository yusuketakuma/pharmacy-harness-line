import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { publicProfileIssues } from './PharmacyInfoAdminPage'

const complete = {
  displayName: 'みどり薬局', phone: '03-1234-5678', faxNumber: '03-1234-5679', postalCode: '100-0001',
  address: '東京都千代田区千代田1-1', businessHours: '月〜金 9:00〜18:00',
  closureNotice: '', accessNote: '', parkingNote: '', googleMapsUrl: '',
  prescriptionReceptionHours: '', afterHoursNote: '', servicesNote: '',
  accessibilityNote: '', supportedLanguages: '', paymentMethods: '', websiteUrl: '',
}

describe('pharmacy public profile admin page', () => {
  it('requires the minimum patient-facing information and validates Google Maps', () => {
    expect(publicProfileIssues(complete)).toEqual([])
    expect(publicProfileIssues({ ...complete, displayName: '', address: '', businessHours: '' }))
      .toEqual(['薬局名', '住所', '営業時間'])
    expect(publicProfileIssues({ ...complete, googleMapsUrl: 'javascript:alert(1)' }))
      .toContain('Google Maps URL')
    expect(publicProfileIssues({ ...complete, websiteUrl: 'http://example.test' }))
      .toContain('公式サイトURL')
  })

  it('provides bounded fields, save feedback, and selected-account loading guards', () => {
    const source = readFileSync(new URL('./PharmacyInfoAdminPage.tsx', import.meta.url), 'utf8')
    for (const field of ['薬局名', '電話番号', 'FAX番号', '郵便番号', '住所', '営業時間',
      '処方せん受付時間', '時間外の対応', '利用できるサービス', 'バリアフリー',
      '対応言語', '支払方法', '公式サイトURL', '休業・臨時案内', 'アクセス案内',
      '駐車場案内', 'Google Maps URL']) {
      expect(source).toContain(field)
    }
    expect(source).toContain('selectedAccountRef')
    expect(source).toContain("role=\"status\"")
    expect(source).toContain('disabled={busy')
  })
})
