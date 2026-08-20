'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { platformAdminApi, type PlatformTenant } from '@/lib/platform-admin-api'

function statusBadgeClass(status: string): string {
  return status === 'active'
    ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800'
    : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
}

const PAGE_SIZE = 50

export default function PlatformAdminTenantsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  useEffect(() => {
    platformAdminApi.tenants()
      .then((res) => setTenants(res.data))
      .catch((caught: Error) => setError(caught.message))
  }, [])

  useEffect(() => setPage(0), [query])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (tenants ?? []).filter((tenant) => !needle ||
      `${tenant.tenantCode} ${tenant.displayName} ${tenant.status}`.toLowerCase().includes(needle))
  }, [query, tenants])
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">テナント一覧</h1>
      <label htmlFor="tenant-search" className="mb-4 block max-w-md text-sm">テナントを検索
        <input id="tenant-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>
      {error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}
      {!tenants && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {tenants && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">テナントコード</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2">健全性</th>
                <th className="px-3 py-2 text-right">LINEアカウント数</th>
                <th className="px-3 py-2 text-right">スタッフ数</th>
                <th className="px-3 py-2 text-right">登録患者数</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tenant) => (
                <tr key={tenant.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono">
                    <Link
                      href={`/platform-admin/tenants/detail?id=${encodeURIComponent(tenant.id)}`}
                      className="inline-flex min-h-11 items-center text-purple-800 underline"
                    >
                      {tenant.tenantCode}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{tenant.displayName}</td>
                  <td className="px-3 py-2">
                    <span className={statusBadgeClass(tenant.status)}>{tenant.status}</span>
                    {tenant.outboundMessagingPausedAt && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">患者向けLINE送信一時停止中</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {tenant.webhookFailureCount > 0 ? (
                      <span className="text-red-700">Webhook失敗 {tenant.webhookFailureCount}件</span>
                    ) : tenant.lineConfigIssueCount > 0 ? (
                      <span className="text-amber-800">LINE設定不足 {tenant.lineConfigIssueCount}件</span>
                    ) : (
                      <span className="text-green-700">正常</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{tenant.lineAccountCount}</td>
                  <td className="px-3 py-2 text-right">{tenant.staffCount}</td>
                  <td className="px-3 py-2 text-right">{tenant.patientCount}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">テナントがありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {tenants && filtered.length > PAGE_SIZE && <div className="mt-4 flex items-center gap-3 text-sm">
        <button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)} className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50">前へ</button>
        <span>{page + 1} / {pages}ページ</span>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((current) => current + 1)} className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50">次へ</button>
      </div>}
    </div>
  )
}
