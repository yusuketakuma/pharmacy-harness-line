'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'

interface TestSendSectionProps {
  broadcastId: string
  accountId: string
  disabled: boolean
}

export function shouldRetainTestSendKey(result: { success: boolean; failed?: number }): boolean {
  return !result.success || (result.failed ?? 0) > 0
}

export default function TestSendSection({ broadcastId, accountId, disabled }: TestSendSectionProps) {
  const [recipients, setRecipients] = useState<Array<{ id: string; displayName: string; pictureUrl: string | null }>>([])
  const [recipientsAccountId, setRecipientsAccountId] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ sent: number; failed: number; at: string; status: 'success' | 'partial' | 'error' } | null>(null)
  const [cooldown, setCooldown] = useState(false)
  const retryKeyRef = useRef<string | null>(null)
  const visibleRecipients = recipientsAccountId === accountId ? recipients : []

  useEffect(() => {
    retryKeyRef.current = null
    setResult(null)
    setCooldown(false)
  }, [accountId, broadcastId])

  useEffect(() => {
    let cancelled = false
    setRecipients([])
    setRecipientsAccountId(accountId)
    api.accountSettings.getTestRecipients(accountId).then(res => {
      if (!cancelled && res.success) setRecipients(res.data)
    })
    return () => { cancelled = true }
  }, [accountId])

  const handleTestSend = async () => {
    const idempotencyKey = retryKeyRef.current ?? crypto.randomUUID()
    retryKeyRef.current = idempotencyKey
    setSending(true)
    try {
      const res = await api.broadcasts.testSend(broadcastId, idempotencyKey)
      if (!res.success) throw new Error(res.error)
      const sent = res.sent ?? 0
      const failed = res.failed ?? 0
      setResult({
        sent,
        failed,
        at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        status: failed > 0 ? 'partial' : 'success',
      })
      if (!shouldRetainTestSendKey(res)) {
        retryKeyRef.current = null
        setCooldown(true)
        setTimeout(() => setCooldown(false), 10000)
      }
    } catch {
      setResult({ sent: 0, failed: 0, at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), status: 'error' })
    } finally { setSending(false) }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">テスト送信</h3>
      {visibleRecipients.length === 0 ? (
        <p className="text-xs text-gray-400">
          テスト送信先が未設定です。
          <a href="/accounts" className="text-blue-500 hover:underline ml-1">アカウント設定</a>
          から設定してください。
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-2">
            送信先: {visibleRecipients.map(r => r.displayName).join(', ')} ({visibleRecipients.length}名)
          </p>
          <button
            onClick={handleTestSend}
            disabled={disabled || sending || cooldown}
            className="px-4 py-2 min-h-[44px] text-xs font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {sending ? 'テスト送信中...' : cooldown ? '送信済み' : 'テスト送信する'}
          </button>
          {result && (
            <p className={`text-xs mt-2 ${result.status === 'success' ? 'text-green-600' : 'text-red-600'}`}>
              {result.status === 'error'
                ? `${result.at} テスト送信に失敗しました`
                : result.status === 'partial'
                  ? `${result.at} 一部失敗 (${result.sent}名成功, ${result.failed}名失敗) — 同じ送信を再試行できます`
                  : `${result.at} テスト送信済み (${result.sent}名成功)`}
            </p>
          )}
        </>
      )}
    </div>
  )
}
