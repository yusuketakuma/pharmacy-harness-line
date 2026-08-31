'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import { ApiError, fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

export type ActiveSession = {
  current: boolean
  sessionKind: 'bootstrap' | 'standard'
  createdAt: string
  expiresAt: string
}

export type SessionListResponse = ApiResponse<{ sessions: ActiveSession[] }>

type SessionSecurityViewProps = {
  sessions: ActiveSession[]
  loading: boolean
  error: string
  message: string
  currentPassword: string
  busy: boolean
  onPasswordChange: (value: string) => void
  onRevoke: () => void
}

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function SessionSecurityView({
  sessions,
  loading,
  error,
  message,
  currentPassword,
  busy,
  onPasswordChange,
  onRevoke,
}: SessionSecurityViewProps) {
  const otherSessionCount = sessions.filter((session) => !session.current).length

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-gray-900">ログイン中の端末</h2>
          <p className="mt-1 text-sm text-gray-500">
            現在有効な管理画面セッションです。端末名や位置情報は保存していません。
          </p>
        </div>

        {loading ? (
          <p role="status" className="py-6 text-center text-sm text-gray-500">読み込み中...</p>
        ) : sessions.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">有効なセッションはありません</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {sessions.map((session, index) => (
              <li key={index} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      session.current
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}>
                      {session.current ? 'この端末' : '他の端末'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {session.sessionKind === 'bootstrap' ? '初回設定' : '通常ログイン'}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-gray-700">ログイン: {dateTime.format(new Date(session.createdAt))}</p>
                </div>
                <p className="text-xs text-gray-500">有効期限: {dateTime.format(new Date(session.expiresAt))}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">他の端末をログアウト</h2>
        <p id="revoke-description" className="mt-1 text-sm text-gray-500">
          この端末は残し、ほかの {otherSessionCount} 件のセッションを終了します。
        </p>

        <form
          className="mt-5 max-w-md"
          onSubmit={(event) => {
            event.preventDefault()
            onRevoke()
          }}
        >
          <label htmlFor="current-password" className="mb-1 block text-sm font-medium text-gray-700">
            現在のパスワード
          </label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            aria-describedby="revoke-description"
            value={currentPassword}
            onChange={(event) => onPasswordChange(event.target.value)}
            disabled={busy}
            className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={busy || loading || !currentPassword || otherSessionCount === 0}
            className="mt-3 min-h-[44px] w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'ログアウト中...' : '他の端末をログアウト'}
          </button>
        </form>

        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        {message && <p role="status" className="mt-3 text-sm text-green-700">{message}</p>}
      </section>
    </div>
  )
}

export default function SessionSecurityPage() {
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetchApi<SessionListResponse>('/api/auth/sessions')
      if (!response.success) throw new Error(response.error)
      setSessions(response.data.sessions)
    } catch {
      setError('ログイン中の端末を取得できませんでした')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const revokeOtherSessions = async () => {
    if (busy || !currentPassword) return
    if (!window.confirm('この端末以外をすべてログアウトします。よろしいですか？')) return

    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetchApi<ApiResponse<{ revoked: number }>>(
        '/api/auth/sessions/revoke-others',
        {
          method: 'POST',
          body: JSON.stringify({ currentPassword }),
        },
      )
      if (!response.success) throw new Error(response.error)
      setCurrentPassword('')
      setMessage(`${response.data.revoked} 件のセッションをログアウトしました`)
      await loadSessions()
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 403
          ? '現在のパスワードを確認してください'
          : '他の端末をログアウトできませんでした',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Header
        title="セッション・セキュリティ"
        description="利用中の管理画面セッションを確認し、不要な端末をログアウトできます。"
      />
      <SessionSecurityView
        sessions={sessions}
        loading={loading}
        error={error}
        message={message}
        currentPassword={currentPassword}
        busy={busy}
        onPasswordChange={setCurrentPassword}
        onRevoke={revokeOtherSessions}
      />
    </div>
  )
}
