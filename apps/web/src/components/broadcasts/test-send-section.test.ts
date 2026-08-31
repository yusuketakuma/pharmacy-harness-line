import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldRetainTestSendKey } from './test-send-section'

describe('test send retry key', () => {
  it('retains the same operation for failures and clears it only after full success', () => {
    expect(shouldRetainTestSendKey({ success: false })).toBe(true)
    expect(shouldRetainTestSendKey({ success: true, failed: 1 })).toBe(true)
    expect(shouldRetainTestSendKey({ success: true, failed: 0 })).toBe(false)
  })

  it('does not show recipients loaded for a previous account', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/broadcasts/test-send-section.tsx'), 'utf8')

    expect(source).toContain('setRecipients([])')
    expect(source).toContain('if (!cancelled && res.success)')
    expect(source).toContain('return () => { cancelled = true }')
    expect(source).toContain('recipientsAccountId === accountId ? recipients : []')
  })

  it('isolates pending send state by broadcast and account', () => {
    const parent = readFileSync(join(process.cwd(), 'src/components/broadcasts/broadcast-detail.tsx'), 'utf8')

    expect(parent).toContain('key={`${id}:${accountId}`}')
  })
})
