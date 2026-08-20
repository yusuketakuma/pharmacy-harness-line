import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  continuityPatientLabel,
  NextIntakeOfferForm,
  tokyoLocalToIso,
} from './ContinuityAdminPage'

describe('next intake admin controls', () => {
  it('uses native manual timing inputs without promising medicine preparation', () => {
    const html = renderToStaticMarkup(<NextIntakeOfferForm
      obligationId="obligation-1"
      busy={false}
      onOffer={async () => undefined}
    />)

    expect(html).toContain('次回事前送信のお知らせ')
    expect(html).toContain('服用日数を手入力')
    expect(html).toContain('type="number"')
    expect(html).toContain('type="date"')
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('薬の確保や調剤を約束する登録ではありません')
  })

  it('stores the pharmacy-entered time as an explicit JST instant', () => {
    expect(tokyoLocalToIso('2026-09-15T09:00')).toBe('2026-09-15T00:00:00.000Z')
  })

  it('identifies each follow-up patient with an account-scoped display name', () => {
    expect(continuityPatientLabel({
      patient_id: 'patient-1', patient_display_name: '山田 太郎',
    })).toBe('山田 太郎')
    expect(continuityPatientLabel({
      patient_id: 'patient-1', patient_display_name: null,
    })).toBe('患者ID: patient-1')
  })

  it('shows the actual reminder time and lets staff stop a pending notice safely', () => {
    const page = readFileSync(new URL('./ContinuityAdminPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain('お知らせ予定')
    expect(page).toContain('window.confirm')
    expect(page).toContain('continuityAdminApi.endExpectation')
    expect(page).toContain('お知らせを取り消す')
  })
})
