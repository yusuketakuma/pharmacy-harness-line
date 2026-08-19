'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  platformAdminApi,
  type PlatformDashboard,
  type PlatformIntegrityCheck,
} from '@/lib/platform-admin-api'

const TILES: Array<[keyof PlatformDashboard, string]> = [
  ['totalTenants', 'テナント総数'],
  ['activeTenants', '稼働中'],
  ['suspendedTenants', '停止中'],
  ['webhookFailures24h', 'Webhook失敗(24h)'],
  ['webhookPending', 'Webhook未処理'],
  ['activeSupportGrants', '有効なサポートモード'],
  ['tenantsWithStaleActivity', '30日以上ログインなし'],
]

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

  useEffect(() => {
    Promise.all([platformAdminApi.dashboard(), platformAdminApi.integrity()])
      .then(([summary, integrity]) => {
        setDashboard(summary.data)
        setChecks(integrity.data)
      })
      .catch((caught: Error) => setError(caught.message))
  }, [])

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">ダッシュボード</h1>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!dashboard && !error && <p className="text-sm text-gray-500">読み込み中...</p>}

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
