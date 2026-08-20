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
})
