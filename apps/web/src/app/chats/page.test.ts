import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('chat safety and accessibility', () => {
  it('keeps direct-message failures visible and refreshes the parent after success', () => {
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

    expect(page).toContain('setDirectError')
    expect(page).toContain('await onSent()')
    expect(page).toContain('個別メッセージを送信できませんでした')
    expect(page).toContain('aria-label="チャット一覧へ戻る"')
    expect(page).toContain("msg.direction === 'incoming' ? '患者から受信した画像' : '送信した画像'")
  })

  it('gates every manual one-to-one send and marks it for the harness', () => {
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../../lib/api.ts', import.meta.url), 'utf8')

    expect(page).toContain('この相手へ個別メッセージを送信します')
    expect(page).toContain("'X-Line-Harness-Source': 'manual'")
    expect(api).toContain("'X-Line-Harness-Source': 'manual'")
  })

  it('keeps disabled pharmacy chat review-only without exposing backend errors', () => {
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

    expect(page).toContain('api.pharmacyGrowth.config')
    expect(page).toContain("capabilities.includes('manual_chat')")
    expect(page).toContain("const chatMutationAllowed = manualChatState === 'enabled'")
    expect(page).toContain('確認のみ')
    expect(page).toContain('readOnly={!chatMutationAllowed}')
    expect(page).toContain('if (!chatMutationAllowed')
    expect(page).not.toContain('err.message')
    expect(page).not.toContain('String(err)')
    expect(page).not.toContain("res as { error?: string }")
  })
})
