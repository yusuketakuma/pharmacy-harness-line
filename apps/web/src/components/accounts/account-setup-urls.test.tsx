import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AccountSetupUrls from './account-setup-urls'

describe('account setup URLs', () => {
  it('uses the dedicated LIFF Pages origin for the LIFF endpoint', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example.test')
    vi.stubEnv('NEXT_PUBLIC_LIFF_ORIGIN', 'https://liff.example.test/')

    const html = renderToStaticMarkup(<AccountSetupUrls liffId="2009624792-AbCdEfGh" />)

    expect(html).toContain('https://liff.example.test/?liffId=2009624792-AbCdEfGh')
    expect(html).not.toContain('https://worker.example.test/?liffId=2009624792-AbCdEfGh')
  })
})
