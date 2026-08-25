'use client'
import { tenantStatusLabel } from '@/lib/platform-admin-labels'
import { readinessStatusLabel } from '@/custom/pharmacy/growth-loop/FeatureSettingsPage'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  platformAdminApi,
  platformAdminErrorMessage,
  type PlatformDashboard,
  type PlatformReadinessStatus,
  type PlatformTenant,
} from '@/lib/platform-admin-api'

function statusBadgeClass(status: string): string {
  return status === 'active'
    ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800'
    : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
}

const PAGE_SIZE = 50

type TenantReadinessProjection = {
  status: PlatformReadinessStatus
  checkedAt: string | null
}

function readinessBadgeClass(status: PlatformReadinessStatus): string {
  return status === 'READY'
    ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800'
    : status === 'BLOCKED'
      ? 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
      : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900'
}

function tenantReadinessProjection(dashboard: PlatformDashboard | null): Map<string, TenantReadinessProjection> {
  const result = new Map<string, TenantReadinessProjection>()
  if (!dashboard) return result
  for (const tenant of dashboard.pharmacyReadiness.tenants) {
    const status: PlatformReadinessStatus = tenant.statusCounts.BLOCKED > 0
      ? 'BLOCKED'
      : tenant.statusCounts.UNVERIFIED > 0
        ? 'UNVERIFIED'
        : tenant.statusCounts.READY > 0
          ? 'READY'
          : 'UNVERIFIED'
    const checkedAt = tenant.accounts.reduce<string | null>((latest, account) => {
      if (!latest || new Date(account.checkedAt).getTime() > new Date(latest).getTime()) return account.checkedAt
      return latest
    }, null)
    result.set(tenant.tenantId, { status, checkedAt })
  }
  return result
}

export default function PlatformAdminTenantsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null)
  const [dashboard, setDashboard] = useState<PlatformDashboard | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [tenantState, setTenantState] = useState<'loading' | 'ready' | 'unverified'>('loading')
  const [readinessState, setReadinessState] = useState<'loading' | 'ready' | 'unverified'>('loading')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setError('')
    setTenantState('loading')
    setReadinessState('loading')
    setTenants(null)
    setDashboard(null)
    setLastUpdated(null)
    const [tenantResult, dashboardResult] = await Promise.allSettled([
      platformAdminApi.tenants(),
      platformAdminApi.dashboard(),
    ])
    if (tenantResult.status === 'fulfilled') {
      setTenants(tenantResult.value.data)
      setTenantState('ready')
    } else {
      setTenants(null)
      setTenantState('unverified')
      setError(platformAdminErrorMessage(tenantResult.reason))
    }
    if (dashboardResult.status === 'fulfilled') {
      setDashboard(dashboardResult.value.data)
      setReadinessState('ready')
    } else {
      setDashboard(null)
      setReadinessState('unverified')
      if (tenantResult.status === 'fulfilled') setError(platformAdminErrorMessage(dashboardResult.reason))
    }
    if (tenantResult.status === 'fulfilled' || dashboardResult.status === 'fulfilled') setLastUpdated(new Date())
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => setPage(0), [query])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (tenants ?? []).filter((tenant) => !needle ||
      `${tenant.tenantCode} ${tenant.displayName} ${tenant.status}`.toLowerCase().includes(needle))
  }, [query, tenants])
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const readinessByTenant = useMemo(() => tenantReadinessProjection(dashboard), [dashboard])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">テナント一覧</h1>
          {lastUpdated && <p className="text-xs text-gray-500">最終更新: {lastUpdated.toLocaleString('ja-JP')}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} disabled={tenantState === 'loading' || readinessState === 'loading'} className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:opacity-50">再取得</button>
          <Link href="/platform-admin/tenants/new" className="inline-flex min-h-11 items-center rounded-lg bg-purple-800 px-4 text-sm font-semibold text-white">新規テナントを設定</Link>
        </div>
      </div>
      <label htmlFor="tenant-search" className="mb-4 block max-w-md text-sm">テナントを検索
        <input id="tenant-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>
      {error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}
      {tenantState === 'unverified' && <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">UNVERIFIED — テナント一覧を確認できません。再取得してください。</p>}
      {readinessState === 'unverified' && <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">UNVERIFIED — readinessを確認できません。各テナントを未確認として表示しています。</p>}
      {!tenants && tenantState === 'loading' && <p className="text-sm text-gray-500">読み込み中...</p>}
      {tenants && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">テナントコード</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2">健全性</th>
                <th className="px-3 py-2">readiness</th>
                <th className="px-3 py-2">最終確認</th>
                <th className="px-3 py-2 text-right">LINEアカウント数</th>
                <th className="px-3 py-2 text-right">スタッフ数</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tenant) => {
                const projection = readinessState === 'ready' ? readinessByTenant.get(tenant.id) : null
                const readinessStatus = projection?.status ?? 'UNVERIFIED'
                return (
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
                    <span className={statusBadgeClass(tenant.status)}>{tenantStatusLabel(tenant.status)}</span>
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
                  <td className="px-3 py-2">
                    <span className={readinessBadgeClass(readinessStatus)}>{readinessStatus}（{readinessStatusLabel(readinessStatus)}）</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{projection?.checkedAt ? new Date(projection.checkedAt).toLocaleString('ja-JP') : '未確認'}</td>
                  <td className="px-3 py-2 text-right">{tenant.lineAccountCount}</td>
                  <td className="px-3 py-2 text-right">{tenant.staffCount}</td>
                  <td className="px-3 py-2">
                    <Link href={`/platform-admin/tenants/detail?id=${encodeURIComponent(tenant.id)}`} className="inline-flex min-h-11 items-center text-purple-800 underline">設定を修正</Link>
                  </td>
                </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">テナントがありません</td></tr>
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
