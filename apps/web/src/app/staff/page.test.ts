import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('staff account assignment UI', () => {
  it('loads and saves tenant account assignments for an existing staff member', () => {
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

    expect(page).toContain('担当薬局を設定')
    expect(page).toContain('`/api/staff/${member.id}/accounts`')
    expect(page).toContain('JSON.stringify({ accountIds:')
    expect(page).toContain('この薬局の担当者を0人にはできません')
  })
})
