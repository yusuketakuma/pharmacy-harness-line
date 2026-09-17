import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { templateFormError } from './ChatTemplatesPanel'

const panelSource = readFileSync(
  new URL('./ChatTemplatesPanel.tsx', import.meta.url), 'utf8')
const chatsSource = readFileSync(
  new URL('../../../app/chats/page.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(
  new URL('../growth-loop/FeatureSettingsPage.tsx', import.meta.url), 'utf8')

describe('chat templates panel helpers', () => {
  it('rejects empty, overlong, and placeholder-bearing input', () => {
    expect(templateFormError('受付確認', '処方せんを受け付けました。')).toBeNull()
    expect(templateFormError(' ', '本文')).toContain('名前')
    expect(templateFormError('名前', ' ')).toContain('本文')
    expect(templateFormError('名前', 'a'.repeat(501))).toContain('500')
    expect(templateFormError('名前', '{{患者名}} 様')).toContain('差し込み記号')
  })

  it('keeps approval gating, optimistic locking, and destructive confirmations', () => {
    expect(panelSource).toContain("template.status === 'draft' && canMutate")
    expect(panelSource).toContain('expectedVersion: editing.version')
    expect(panelSource).toContain('cause instanceof ApiError && cause.status === 409')
    expect(panelSource).toContain('再度の承認が必要です')
    expect(panelSource).toContain('window.confirm')
    expect(panelSource).toContain('mutatingId !== null')
    expect(panelSource).toContain('min-h-11')
    expect(panelSource).toContain('role="alert"')
  })

  it('is offered only when the manual_chat capability is enabled', () => {
    expect(settingsSource).toContain("config?.capabilities.includes('manual_chat')")
    expect(settingsSource).toContain('ChatTemplatesPanel')
  })

  it('inserts approved templates into the existing manual composer only', () => {
    expect(chatsSource).toContain('custom:pharmacy-chat-templates')
    expect(chatsSource).toContain("chatTemplateApi.list(selectedAccount.id, 'approved')")
    expect(chatsSource).toContain('chatMutationAllowed')
    expect(chatsSource).toContain('setMessageContent')
    // The send path itself is untouched: manual header + confirm stay intact.
    expect(chatsSource).toContain("'X-Line-Harness-Source': 'manual'")
    expect(chatsSource).toContain('この相手へ個別メッセージを送信します')
  })
})
