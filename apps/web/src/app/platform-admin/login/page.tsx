'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  PlatformAdminApiError,
  platformAdminApi,
  platformAdminErrorMessage,
  setPlatformAdminName,
} from '@/lib/platform-admin-api'

/**
 * 全体管理者ログイン。テナント管理者ログイン (/login) と同じ構造だが、
 * 薬局コードは持たない (全体管理者の loginId はグローバルに一意)。
 * 配色も紫系に変えて、どちらのポータルにいるか一目で分かるようにしている。
 */
export default function PlatformAdminLoginPage() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const loginData = await platformAdminApi.login(loginId, password)
      setPlatformAdminName(loginData?.data?.name)
      if (loginData?.data?.mustChangePassword) {
        setCurrentPassword(password)
        setPassword('')
        setPasswordChangeRequired(true)
        return
      }
      router.push('/platform-admin/tenants')
    } catch (caught) {
      if (caught instanceof PlatformAdminApiError) {
        setError(caught.status === 401
          ? '管理者IDまたはパスワードが正しくありません'
          : platformAdminErrorMessage(caught))
        return
      }
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault()
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
      await platformAdminApi.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      router.push('/platform-admin/tenants')
    } catch (caught) {
      setError(platformAdminErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-purple-900">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm border-t-8 border-purple-600">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg mx-auto mb-3 bg-purple-600">P</div>
          <h1 className="text-xl font-bold text-gray-900">全体管理者ログイン</h1>
          <p className="text-xs font-semibold tracking-wide text-purple-700 mt-1">Platform Admin</p>
          <p className="text-sm text-gray-500 mt-1">
            {passwordChangeRequired ? '初回パスワードを変更' : '全テナントを横断する管理者用ポータルです'}
          </p>
        </div>

        {passwordChangeRequired ? (
          <form onSubmit={handlePasswordChange}>
            <p className="text-sm text-gray-600 mb-4">仮パスワードを新しいパスワードへ変更してください。</p>
            <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 mb-1">現在の仮パスワード</label>
            <input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
            <input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">新しいパスワード（確認）</label>
            <input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
            <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="w-full py-3 text-white font-medium rounded-lg bg-purple-600 disabled:opacity-50">
              {loading ? '変更中...' : 'パスワードを変更して進む'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin}>
            <label htmlFor="login-id" className="block text-sm font-medium text-gray-700 mb-1">全体管理者ID</label>
            <input id="login-id" type="text" value={loginId} onChange={(event) => setLoginId(event.target.value)} placeholder="全体管理者IDを入力" autoComplete="username" autoFocus className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="パスワードを入力" autoComplete="current-password" className="w-full px-4 py-3 mb-4 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />

            {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
            <button type="submit" disabled={loading || !loginId || !password} className="w-full py-3 text-white font-medium rounded-lg bg-purple-600 disabled:opacity-50">
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
