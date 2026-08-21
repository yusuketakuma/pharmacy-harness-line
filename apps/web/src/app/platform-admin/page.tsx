'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  platformAdminApi,
  type PlatformDashboard,
  type PlatformIntegrityCheck,
} from '@/lib/platform-admin-api'

const TILES = [
  ['totalTenants', 'テナント総数'],
  ['activeTenants', '稼働中'],
  ['suspendedTenants', '停止中'],
  ['webhookFailures24h', 'Webhook失敗(24h)'],
  ['webhookPending', 'Webhook未処理'],
  ['activeSupportGrants', '有効なサポートモード'],
  ['tenantsWithStaleActivity', '30日以上ログインなし'],
] as const

const CHECK_LABELS: Record<string, string> = {
  orphaned_tenant_line_accounts: '孤立したLINEアカウント紐付け',
  missing_capability_row: 'capability行の欠落',
  patients_without_active_account_mapping: 'テナント未紐付けの患者',
  stale_pending_webhook_events: '滞留中のpending Webhook',
  dangling_source_handoff: '参照先のないsource_handoff_id',
}

const STATUS_STYLE: Record<PlatformIntegrityCheck['status'], string> = {
  ok: 'bg-green-100 text-green-800',
  warn: 'bg-amber-100 text-amber-900',
  critical: 'bg-red-100 text-red-800',
}

export default function PlatformAdminDashboardPage() {
  const [dashboard, setDashboard] = useState<PlatformDashboard | null>(null)
  const [checks, setChecks] = useState<PlatformIntegrityCheck[] | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    setError('')
    const [summary, integrity] = await Promise.allSettled([
      platformAdminApi.dashboard(),
      platformAdminApi.integrity(),
    ])
    if (summary.status === 'fulfilled') setDashboard(summary.value.data)
    if (integrity.status === 'fulfilled') setChecks(integrity.value.data)
    if (summary.status === 'rejected' || integrity.status === 'rejected') {
      setError('一部の情報を取得できませんでした。表示中の値は前回取得時点の可能性があります。')
    }
    if (summary.status === 'fulfilled' || integrity.status === 'fulfilled') setLastUpdated(new Date())
    setRefreshing(false)
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">ダッシュボード</h1>
          {lastUpdated && <p className="text-xs text-gray-500">最終更新: {lastUpdated.toLocaleString('ja-JP')}</p>}
        </div>
        <button type="button" onClick={() => void load()} disabled={refreshing} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">
          {refreshing ? '取得中...' : '再取得'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!dashboard && refreshing && <p className="text-sm text-gray-500">読み込み中...</p>}

      {dashboard && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {TILES.map(([key, label]) => (
            <div key={key} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="mt-1 text-2xl font-bold">{dashboard[key]}</div>
            </div>
          ))}
        </div>
      )}

      {dashboard && <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="font-semibold">薬局readiness</h2><p className="text-xs text-gray-500">患者数や対応中件数を含まない設定状態です。</p></div>
          <p className="text-xs text-gray-500">更新: {new Date(dashboard.pharmacyReadiness.checkedAt).toLocaleString('ja-JP')}</p>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          {(['READY', 'BLOCKED', 'UNVERIFIED'] as const).map((status) => <div key={status} className="rounded bg-gray-50 p-3"><dt className="text-xs text-gray-500">{status}</dt><dd className="text-xl font-bold">{dashboard.pharmacyReadiness.statusCounts[status]}</dd></div>)}
        </dl>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm"><thead className="bg-gray-50 text-left text-xs text-gray-600"><tr><th className="px-3 py-2">tenant / account</th><th className="px-3 py-2">READY</th><th className="px-3 py-2">BLOCKED</th><th className="px-3 py-2">UNVERIFIED</th><th className="px-3 py-2">確認時刻</th></tr></thead>
            <tbody>{dashboard.pharmacyReadiness.tenants.flatMap((tenant) => [
              <tr key={tenant.tenantId} className="border-t border-gray-200 bg-gray-50 font-medium"><td className="px-3 py-2 font-mono text-xs">{tenant.tenantId}</td><td className="px-3 py-2">{tenant.statusCounts.READY}</td><td className="px-3 py-2">{tenant.statusCounts.BLOCKED}</td><td className="px-3 py-2">{tenant.statusCounts.UNVERIFIED}</td><td className="px-3 py-2">tenant合計</td></tr>,
              ...tenant.accounts.map((account) => <tr key={`${tenant.tenantId}:${account.accountId}`} className="border-t border-gray-100"><td className="px-3 py-2 pl-6 font-mono text-xs text-gray-600">{account.accountId}</td><td className="px-3 py-2">{account.statusCounts.READY}</td><td className="px-3 py-2">{account.statusCounts.BLOCKED}</td><td className="px-3 py-2">{account.statusCounts.UNVERIFIED}</td><td className="px-3 py-2">{new Date(account.checkedAt).toLocaleString('ja-JP')}</td></tr>),
            ])}</tbody>
          </table>
        </div>
      </section>}

      {dashboard && <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-semibold">バージョン識別</h2>
        <p className="mt-1 text-xs text-gray-500">seller release、LIFF package、Web runtime、Worker runtimeは別々の証拠として表示します。</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-gray-500">seller release</dt><dd className="font-mono">{dashboard.versions.sellerRelease ?? '未設定'}</dd></div>
          <div><dt className="text-gray-500">LIFF package</dt><dd className="font-mono">{dashboard.versions.liffPackageVersion}</dd></div>
          <div><dt className="text-gray-500">Web runtime</dt><dd className="font-mono">package {dashboard.versions.webRuntime.packageVersion}<span className="block text-xs text-gray-500">bundle {dashboard.versions.webRuntime.bundleVersion}</span></dd></div>
          <div><dt className="text-gray-500">Worker runtime</dt><dd className="font-mono">package {dashboard.versions.workerRuntime.packageVersion}<span className="block text-xs text-gray-500">bundle {dashboard.versions.workerRuntime.bundleVersion}</span></dd></div>
        </dl>
      </section>}

      {checks && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-semibold">データ整合性</h2>
          <ul className="space-y-2 text-sm">
            {checks.map((check) => (
              <li key={check.name} className="flex flex-wrap items-center gap-3">
                <span className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[check.status]}`}>
                  {check.status}
                </span>
                <span>{CHECK_LABELS[check.name] ?? check.name}</span>
                <span className="text-gray-500">{check.affectedCount}件</span>
                {check.sampleIds.length > 0 && (
                  <span className="font-mono text-xs text-gray-500">{check.sampleIds.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href="/platform-admin/tenants" className="inline-block text-sm text-purple-800 underline">
        テナント一覧へ →
      </Link>
    </div>
  )
}
