import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountFormSections, emptyAccountFormState } from './account-form-fields'

describe('pharmacy LINE account form', () => {
  it('marks Login and LIFF wiring as required for new accounts', () => {
    const html = renderToStaticMarkup(
      <AccountFormSections
        state={emptyAccountFormState}
        update={() => undefined}
        showMessagingRequired
        showLoginRequired
      />,
    )

    expect(html).toContain('LINE Login（必須）')
    expect(html).toContain('LIFF（必須）')
  })
})
