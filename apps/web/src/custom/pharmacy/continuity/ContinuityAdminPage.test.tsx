import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NextIntakeOfferForm, tokyoLocalToIso } from './ContinuityAdminPage'

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
})
