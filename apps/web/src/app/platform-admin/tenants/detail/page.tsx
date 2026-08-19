'use client'
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { platformAdminApi, type PlatformTenantDetail } from '@/lib/platform-admin-api'

function TenantDetail({ tenantId }: { tenantId: string }) {
  const [tenant, setTenant] = useState<PlatformTenantDetail | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [status, setStatus] = useState('active')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    platformAdminApi.tenant(tenantId)
      .then((res) => {
        setTenant(res.data)
        setDisplayName(res.data.displayName)
        setStatus(res.data.status)
      })
      .catch((caught: Error) => setError(caught.message))
  }, [tenantId])

  useEffect(load, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!tenant) return
    // PATCH は displayName / status しか受け付けない (tenantCode は不変)。
    // 実際に変わったフィールドだけを送る。
    const changes: { displayName?: string; status?: string } = {}
    if (displayName !== tenant.displayName) changes.displayName = displayName
    if (status !== tenant.status) changes.status = status
    if (Object.keys(changes).length === 0) {
      setNotice('変更がありません')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await platformAdminApi.updateTenant(tenant.id, changes)
      setNotice('保存しました')
      load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (error && !tenant) return <p role="alert" className="text-sm text-red-600">{error}</p>
  if (!tenant) return <p className="text-sm text-gray-500">読み込み中...</p>

  return (
    <div className="space-y-6">
      <div>
        <Link href="/platform-admin/tenants" className="text-sm text-purple-800 underline">← テナント一覧</Link>
        <h1 className="mt-2 text-xl font-bold">{tenant.displayName}</h1>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">サマリー</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-gray-500">テナントコード</dt><dd className="font-mono">{tenant.tenantCode}</dd></div>
          <div><dt className="text-gray-500">名称</dt><dd>{tenant.displayName}</dd></div>
          <div><dt className="text-gray-500">ステータス</dt><dd>{tenant.status}</dd></div>
          <div><dt className="text-gray-500">LINEアカウント数</dt><dd>{tenant.lineAccountCount}</dd></div>
          <div><dt className="text-gray-500">スタッフ数</dt><dd>{tenant.staffCount}</dd></div>
          <div><dt className="text-gray-500">登録患者数</dt><dd>{tenant.patientCount}</dd></div>
        </dl>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">テナント編集</h2>
        <form onSubmit={save} className="space-y-3">
          <div className="text-sm">
            <span className="block text-gray-500">テナントコード（変更不可）</span>
            <span className="font-mono">{tenant.tenantCode}</span>
          </div>
          <label className="block text-sm" htmlFor="tenant-display-name">名称
            <input
              id="tenant-display-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={120}
              required
              className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm" htmlFor="tenant-status">ステータス
            <select
              id="tenant-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="mt-1 block w-full max-w-md rounded-lg border border-gray-300 bg-white px-3 py-2"
            >
              <option value="active">active</option>
              <option value="suspended">suspended</option>
            </select>
          </label>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-green-700">{notice}</p>}
          <button type="submit" disabled={saving} className="rounded-lg bg-purple-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">LINEアカウント</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">チャネルID</th>
                <th className="px-3 py-2">有効</th>
              </tr>
            </thead>
            <tbody>
              {tenant.lineAccounts.map((account) => (
                <tr key={account.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono">{account.id}</td>
                  <td className="px-3 py-2">{account.name}</td>
                  <td className="px-3 py-2 font-mono">{account.channel_id}</td>
                  <td className="px-3 py-2">{account.is_active ? '有効' : '無効'}</td>
                </tr>
              ))}
              {tenant.lineAccounts.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">LINEアカウントがありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Link
        href={`/platform-admin/tenants/patients?id=${encodeURIComponent(tenant.id)}`}
        className="inline-block text-sm text-purple-800 underline"
      >
        患者一覧を見る（個人の診療記録）→
      </Link>
    </div>
  )
}

function TenantDetailRoute() {
  const tenantId = useSearchParams().get('id')
  if (!tenantId) return <p className="text-sm text-gray-500">テナント ID が指定されていません</p>
  return <TenantDetail tenantId={tenantId} />
}

export default function PlatformAdminTenantDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">読み込み中...</p>}>
      <TenantDetailRoute />
    </Suspense>
  )
}
