'use client'
import { useState, useEffect } from 'react'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'
import type { StaffMember } from '@line-crm/shared'

type NewCredential = { loginId: string; temporaryPassword: string; staffId: string }

function RoleBadge({ role }: { role: string }) {
  const styles =
    role === 'owner'
      ? 'bg-yellow-100 text-yellow-800'
      : role === 'admin'
        ? 'bg-blue-100 text-blue-800'
        : 'bg-gray-100 text-gray-600'
  const label =
    role === 'owner' ? 'オーナー' : role === 'admin' ? '管理者' : 'スタッフ'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

export default function StaffPage() {
  const [members, setMembers] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [newCredential, setNewCredential] = useState<NewCredential | null>(null)
  const [copied, setCopied] = useState(false)

  // Create form
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formLoginId, setFormLoginId] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formRole, setFormRole] = useState<'admin' | 'staff'>('staff')
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState('')

  const loadMembers = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchApi<ApiResponse<StaffMember[]>>('/api/staff')
      if (res.success) {
        setMembers(res.data)
      } else {
        setError(res.error ?? 'スタッフの読み込みに失敗しました')
      }
    } catch {
      setError('スタッフの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMembers()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormLoading(true)
    setFormError('')
    try {
      const body: { name: string; loginId: string; role: 'admin' | 'staff'; email?: string } = {
        name: formName,
        loginId: formLoginId,
        role: formRole,
      }
      if (formEmail) body.email = formEmail

      const res = await fetchApi<ApiResponse<StaffMember & {
        loginId: string
        temporaryPassword: string
      }>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (res.success) {
        setNewCredential({
          loginId: res.data.loginId,
          temporaryPassword: res.data.temporaryPassword,
          staffId: res.data.id,
        })
        setFormName('')
        setFormLoginId('')
        setFormEmail('')
        setFormRole('staff')
        setShowForm(false)
        await loadMembers()
      } else {
        setFormError(res.error ?? '作成に失敗しました')
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setFormLoading(false)
    }
  }

  const handleToggleActive = async (member: StaffMember) => {
    try {
      await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      await loadMembers()
    } catch {
      setError('更新に失敗しました')
    }
  }

  const handleResetPassword = async (member: StaffMember) => {
    const loginId = member.loginId || window.prompt(`${member.name} の管理者IDを入力してください`)?.trim()
    if (!loginId || !confirm(`${member.name} の仮パスワードを再発行しますか？\n現在のログインセッションは無効になります。`)) return
    try {
      const res = await fetchApi<ApiResponse<{ loginId: string; temporaryPassword: string }>>(`/api/staff/${member.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ loginId }),
      })
      if (res.success) {
        setNewCredential({ ...res.data, staffId: member.id })
        await loadMembers()
      } else {
        setError(res.error ?? '仮パスワードの再発行に失敗しました')
      }
    } catch {
      setError('仮パスワードの再発行に失敗しました')
    }
  }

  const handleDelete = async (member: StaffMember) => {
    if (!confirm(`${member.name} を削除しますか？\nこの操作は元に戻せません。`)) return
    try {
      await fetchApi<ApiResponse<null>>(`/api/staff/${member.id}`, { method: 'DELETE' })
      await loadMembers()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleCopy = async () => {
    if (!newCredential) return
    await navigator.clipboard.writeText(newCredential.temporaryPassword)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <Header
        title="スタッフ管理"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + スタッフを追加
          </button>
        }
      />

      {newCredential && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800 mb-2">
            仮パスワードを発行しました。この画面で一度だけ表示されます。
          </p>
          <p className="mb-2 text-xs text-green-800">管理者ID: {newCredential.loginId}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-green-200 rounded px-3 py-2 font-mono break-all">
              {newCredential.temporaryPassword}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-2 text-xs font-medium text-green-700 bg-white border border-green-300 rounded-lg hover:bg-green-50 transition-colors"
            >
              {copied ? 'コピー済み' : 'コピー'}
            </button>
            <button
              onClick={() => setNewCredential(null)}
              className="shrink-0 px-3 py-2 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">新しいスタッフを追加</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">名前 *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                  placeholder="田中 太郎"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">管理者ID *</label>
                <input
                  type="text"
                  value={formLoginId}
                  onChange={(e) => setFormLoginId(e.target.value)}
                  required
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
                  autoComplete="off"
                  placeholder="tanaka.taro"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="taro@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ロール *</label>
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value as 'admin' | 'staff')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="staff">スタッフ</option>
                  <option value="admin">管理者</option>
                </select>
              </div>
            </div>
            {formError && (
              <p className="text-sm text-red-600">{formError}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={formLoading || !formName || !formLoginId}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#06C755' }}
              >
                {formLoading ? '作成中...' : '作成'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError('') }}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Staff list */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-48" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-5 bg-gray-100 rounded w-24" />
              <div className="h-8 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">スタッフがいません。「+ スタッフを追加」から追加してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">名前</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">メール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ロール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">管理者ID</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">状態</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{member.name}</td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{member.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={member.role} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden md:table-cell">
                    {member.loginId ?? '未発行'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${member.isActive ? 'text-green-700' : 'text-gray-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${member.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {member.isActive ? '有効' : '無効'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {member.role !== 'owner' && (
                        <>
                          <button
                            onClick={() => handleToggleActive(member)}
                            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                          >
                            {member.isActive ? '無効化' : '有効化'}
                          </button>
                          <button
                            onClick={() => handleResetPassword(member)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-600 bg-white border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                          >
                            仮パスワード再発行
                          </button>
                          <button
                            onClick={() => handleDelete(member)}
                            className="px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 transition-colors"
                          >
                            削除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
