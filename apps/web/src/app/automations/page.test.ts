import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('automation account scope UI', () => {
  it('requires and sends the selected account when creating an automation', () => {
    const page = source('./page.tsx')

    expect(page).toContain('if (!selectedAccountId)')
    expect(page).toContain('LINEアカウントを選択してください')
    expect(page).toContain('lineAccountId: selectedAccountId')
  })

  it('encodes the account selector and requires it in the create contract', () => {
    const api = source('../../lib/api.ts')
    const automationsStart = api.indexOf('\n  automations: {\n')
    const automationsApi = api.slice(automationsStart, api.indexOf('\n  chats: {\n', automationsStart))

    expect(automationsApi).toContain('encodeURIComponent(params.accountId)')
    expect(automationsApi).toContain('lineAccountId: string')
  })
})
