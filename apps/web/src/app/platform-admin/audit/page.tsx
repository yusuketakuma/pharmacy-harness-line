'use client'
import { useEffect, useMemo, useState } from 'react'
import { platformAdminApi, type PlatformAccessEvent } from '@/lib/platform-admin-api'

/** detail_json は JSON 文字列 (null あり)。壊れていても捨てずに原文を出す。 */
function detailText(raw: string | null): string {
  if (!raw) return '—'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`)
        .join(' / ')
    }
    return String(parsed)
  } catch {
    return raw
  }
}

const PAGE_SIZE = 50
const auditDate = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'Asia/Tokyo',
}).format(new Date(value))

export default function PlatformAdminAuditPage() {
  const [all, setAll] = useState(false)
  const [events, setEvents] = useState<PlatformAccessEvent[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({})

  useEffect(() => {
    platformAdminApi.tenants().then((res) => {
      setTenantNames(Object.fromEntries(res.data.map((tenant) => [tenant.id, `${tenant.tenantCode} / ${tenant.displayName}`])))
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setError('')
    setPage(0)
    platformAdminApi.audit({ all, limit: 200 })
      .then((res) => { if (!cancelled) setEvents(res.data) })
      .catch((caught: Error) => { if (!cancelled) setError(caught.message) })
    return () => { cancelled = true }
  }, [all])

  useEffect(() => setPage(0), [query])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!events || !needle) return events ?? []
    return events.filter((event) => [
      event.action,
      event.resource_type,
      event.resource_id,
      event.platform_admin_id,
      event.tenant_id ? tenantNames[event.tenant_id] ?? event.tenant_id : '',
      detailText(event.detail_json),
    ].some((value) => value?.toLowerCase().includes(needle)))
  }, [events, query, tenantNames])
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-bold">{all ? '全管理者の操作履歴' : '自分の操作履歴'}</h1>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
          全管理者を表示
        </label>
      </div>

      <label className="block max-w-md text-sm" htmlFor="audit-search">監査履歴を検索
        <input id="audit-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="操作、テナント、リソースで検索" />
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!events && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {events && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">日時</th>
                {all && <th className="px-3 py-2">管理者</th>}
                <th className="px-3 py-2">アクション</th>
                <th className="px-3 py-2">テナント</th>
                <th className="px-3 py-2">リソース種別/ID</th>
                <th className="px-3 py-2">詳細</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event) => (
                <tr key={event.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 whitespace-nowrap">{auditDate(event.created_at)}</td>
                  {all && <td className="px-3 py-2 font-mono text-xs" title={event.platform_admin_id}>{event.platform_admin_id.slice(0, 8)}</td>}
                  <td className="px-3 py-2">{event.action}</td>
                  <td className="px-3 py-2 text-xs">{event.tenant_id ? tenantNames[event.tenant_id] ?? event.tenant_id : '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {event.resource_type ?? '—'}{event.resource_id ? ` / ${event.resource_id}` : ''}
                  </td>
                  <td className="px-3 py-2">{detailText(event.detail_json)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={all ? 6 : 5} className="px-3 py-6 text-center text-gray-500">記録がありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {events && filtered.length > PAGE_SIZE && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)} className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50">前へ</button>
          <span>{page + 1} / {pages}ページ（最新200件）</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((current) => current + 1)} className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50">次へ</button>
        </div>
      )}
    </div>
  )
}
