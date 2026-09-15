'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  BrowserStorageUnavailableError,
  getCsrfToken,
  persistStaffSession,
  SessionStateUnavailableError,
} from '@/lib/api'
import { safeNextPath } from '@/lib/safe-next-path'

export default function LoginPage() {
  const [pharmacyCode, setPharmacyCode] = useState('')
  const [password, setPassword] = useState('')
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [nextPath, setNextPath] = useState('/')
  const router = useRouter()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setNextPath(safeNextPath(params.get('next')))
    if (params.get('reason') === 'expired') setNotice('セッションの有効期限が切れました。もう一度ログインしてください')
    if (params.get('reason') === 'password-changed') setNotice('パスワードを変更しました。新しいパスワードでログインしてください')
  }, [])

  const apiUrl = process.env.NEXT_PUBLIC_API_URL

  useEffect(() => {
    if (!apiUrl) return
    let cancelled = false
    void fetch(`${apiUrl}/api/auth/session`, { credentials: 'include' })
      .then(async (response) => response.ok ? response.json() : null)
      .then((sessionResponse) => {
        if (cancelled || !sessionResponse) return
        const sessionData = persistStaffSession(sessionResponse)
        if (sessionData.data.mustChangePassword) {
          setPasswordChangeRequired(true)
          setError('初回パスワード変更を続けてください。現在の仮パスワードをもう一度入力してください')
        } else {
          router.replace(nextPath)
        }
      })
    .catch((caught) => {
      if (!cancelled && caught instanceof BrowserStorageUnavailableError) {
        setError('ブラウザの保存領域を利用できないため、安全なログイン状態を確認できません。保存領域を有効にして再読み込みしてください')
      } else if (!cancelled && caught instanceof SessionStateUnavailableError) {
        setError('安全なセッション情報を確認できないため、ログイン状態を開けません。再読み込みしてください')
      }
    })
    return () => { cancelled = true }
  }, [apiUrl, router, nextPath])

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!apiUrl) {
      setError('ログイン機能を利用できません。管理者へご連絡ください')
      return
    }
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pharmacyCode, password }),
      })
      const loginData = await res.json().catch(() => null)
      if (!res.ok) {
        setError(res.status === 401
          ? '薬局コードまたはパスワードが正しくありません'
          : res.status === 403
            ? 'このアカウントは無効化されています。薬局のオーナーにご確認ください'
          : res.status === 429
            ? 'ログイン試行が多すぎます。しばらく待ってからお試しください'
            : 'ログインに失敗しました。しばらく待ってからお試しください')
        return
      }

      persistStaffSession(loginData)
      if (loginData?.data?.mustChangePassword) {
        setCurrentPassword(password)
        setPassword('')
        setPasswordChangeRequired(true)
        return
      }
      router.push(nextPath)
    } catch (caught) {
      setError(caught instanceof BrowserStorageUnavailableError
        ? 'ブラウザの保存領域を利用できないため、安全なログイン状態を確認できません。保存領域を有効にして再試行してください'
        : caught instanceof SessionStateUnavailableError
          ? '安全なセッション情報を受け取れないため、ログインを続けられません。再試行してください'
        : '接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!apiUrl) return
    const passwordLength = [...newPassword].length
    if (passwordLength < 15 || passwordLength > 128) {
      setError('新しいパスワードは15文字以上128文字以下で入力してください')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('新しいパスワードが一致しません')
      return
    }
    setLoading(true)
    setError('')
    try {
      const csrfToken = getCsrfToken()
      const res = await fetch(`${apiUrl}/api/auth/change-password`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(res.status === 400
          ? '15〜128文字で、よく使われるパスワード以外を指定してください'
          : res.status === 401
            ? 'セッションが切れました。もう一度ログインしてください'
            : 'パスワードを変更できませんでした。もう一度お試しください')
        return
      }
      for (const key of ['lh_csrf', 'lh_staff_name', 'lh_staff_role', 'lh_selected_account']) {
        try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordChangeRequired(false)
      setNotice('パスワードを変更しました。新しいパスワードでログインしてください')
      router.push(`/login?next=${encodeURIComponent(nextPath)}&reason=password-changed`)
    } catch (caught) {
      setError(caught instanceof BrowserStorageUnavailableError
        ? 'ブラウザの保存領域を利用できないため、パスワードを変更できません。保存領域を有効にして再試行してください'
        : caught instanceof SessionStateUnavailableError
          ? 'CSRF情報を利用できないため、パスワードを変更できません。再読み込みしてください'
        : '接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: '#06C755' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg mx-auto mb-3" style={{ backgroundColor: '#06C755' }}>H</div>
          <h1 className="text-xl font-bold text-gray-900">L Harness</h1>
          <p className="text-sm text-gray-500 mt-1">
            {passwordChangeRequired ? '初回パスワードを変更' : '管理画面にログイン'}
          </p>
        </div>

        {passwordChangeRequired ? (
          <form onSubmit={handlePasswordChange}>
            <p className="text-sm text-gray-600 mb-4">仮パスワードを新しいパスワードへ変更してください。</p>
            <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 mb-1">現在の仮パスワード</label>
            <input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
            <input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">新しいパスワード（確認）</label>
            <input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
            <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="w-full py-3 text-white font-medium rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
              {loading ? '変更中...' : 'パスワードを変更して進む'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin}>
            {notice && <p role="status" className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-4">{notice}</p>}
            <label htmlFor="pharmacy-code" className="block text-sm font-medium text-gray-700 mb-1">薬局コード</label>
            {/* type="text" + inputMode preserves leading zeroes in pharmacy codes. */}
            <input id="pharmacy-code" type="text" inputMode="numeric" value={pharmacyCode} onChange={(event) => setPharmacyCode(event.target.value)} placeholder="例: 004821" autoComplete="organization" autoFocus className="w-full px-4 py-3 mb-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <p className="text-xs text-gray-500 mb-4">薬局ごとに発行された6桁の番号です。</p>

            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="パスワードを入力" autoComplete="current-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />

            {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
            <button type="submit" disabled={loading || !pharmacyCode || !password} className="w-full py-3 text-white font-medium rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
            <p className="text-xs text-gray-500 mt-4">パスワードを忘れた場合は、プラットフォーム管理者へ再発行を依頼してください。</p>
          </form>
        )}
      </div>
    </div>
  )
}
