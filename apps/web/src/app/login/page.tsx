'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [pharmacyCode, setPharmacyCode] = useState('')
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const apiUrl = process.env.NEXT_PUBLIC_API_URL

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!apiUrl) {
      setError('NEXT_PUBLIC_API_URL is not set in build env')
      return
    }
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password, pharmacyCode }),
      })
      const loginData = await res.json().catch(() => null)
      if (!res.ok) {
        setError(res.status === 401
          ? '薬局コード、管理者IDまたはパスワードが正しくありません'
          : loginData?.error || 'ログインに失敗しました')
        return
      }

      if (loginData?.data?.name) localStorage.setItem('lh_staff_name', loginData.data.name)
      if (loginData?.data?.role) localStorage.setItem('lh_staff_role', loginData.data.role)
      if (loginData?.csrfToken) localStorage.setItem('lh_csrf', loginData.csrfToken)
      if (loginData?.data?.mustChangePassword) {
        setCurrentPassword(password)
        setPassword('')
        setPasswordChangeRequired(true)
        return
      }
      router.push('/')
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!apiUrl) return
    if (newPassword.length < 12 || newPassword.length > 128) {
      setError('新しいパスワードは12文字以上128文字以下で入力してください')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('新しいパスワードが一致しません')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${apiUrl}/api/auth/change-password`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': localStorage.getItem('lh_csrf') || '',
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error || 'パスワードを変更できませんでした')
        return
      }
      if (data?.csrfToken) localStorage.setItem('lh_csrf', data.csrfToken)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      router.push('/')
    } catch {
      setError('接続に失敗しました')
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
            <label htmlFor="pharmacy-code" className="block text-sm font-medium text-gray-700 mb-1">薬局コード</label>
            {/* type="text" + inputMode, never type="number": a numeric input would drop
                the leading zero of a code like 004821, and legacy tenants still have
                slug-shaped codes that must remain typable. */}
            <input id="pharmacy-code" type="text" inputMode="numeric" value={pharmacyCode} onChange={(event) => setPharmacyCode(event.target.value)} placeholder="例: 004821" autoComplete="organization" autoFocus className="w-full px-4 py-3 mb-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <p className="text-xs text-gray-500 mb-4">薬局ごとに発行された6桁の番号です。</p>

            <label htmlFor="login-id" className="block text-sm font-medium text-gray-700 mb-1">管理者ID</label>
            <input id="login-id" type="text" value={loginId} onChange={(event) => setLoginId(event.target.value)} placeholder="管理者IDを入力" autoComplete="username" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="パスワードを入力" autoComplete="current-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />

            {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
            <button type="submit" disabled={loading || !pharmacyCode || !loginId || !password} className="w-full py-3 text-white font-medium rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
