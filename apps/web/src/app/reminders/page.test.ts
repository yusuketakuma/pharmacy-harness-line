import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('reminder account scope UI', () => {
  it('requires the selected account when creating a reminder', () => {
    const page = source('./page.tsx')

    expect(page).toContain('if (!selectedAccountId)')
    expect(page).toContain('LINEアカウントを選択してください')
    expect(page).toContain('lineAccountId: selectedAccountId')
  })

  it('encodes the account selector before sending it to the worker', () => {
    const api = source('../../lib/api.ts')

    expect(api).toContain('encodeURIComponent(params.accountId)')
    expect(api).toContain('lineAccountId: string')
  })
})
