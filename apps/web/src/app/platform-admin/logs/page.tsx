'use client'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  platformAdminApi,
  platformAdminErrorMessage,
  type PlatformLogType,
  type PlatformLogs,
  type PlatformTenant,
} from '@/lib/platform-admin-api'

const TYPE_OPTIONS: Array<{ value: '' | PlatformLogType; label: string }> = [
  { value: '', label: '全て' },
  { value: 'prescription_events', label: '処方せんイベント' },
  { value: 'webhook_receipts', label: 'Webhook受信' },
  { value: 'platform_admin_access', label: '全体管理者アクセス' },
]

const LOG_COLUMN_LABELS: Record<string, string> = {
  created_at: '日時', received_at: '受信日時', tenant_id: 'テナント',
  line_account_id: 'LINEアカウント', submission_id: '受付対象', event_type: 'イベント',
  actor_type: '実行者種別', from_status: '変更前', to_status: '変更後', id: 'ID',
  webhook_event_id: 'Webhook対象', status: '状態', retry_count: '再試行回数',
  dead_lettered_at: '隔離日時', platform_admin_id: '全体管理者', action: '操作',
  resource_type: '対象種別', resource_id: '対象', detail_json: '詳細',
}

const SAFE_IDENTIFIER_COLUMNS = new Set([
  'tenant_id', 'line_account_id', 'submission_id', 'webhook_event_id',
  'platform_admin_id', 'resource_id', 'id',
])

const logValue = (column: string, value: unknown): string => {
  if (value === null || value === undefined) return '—'
  if (SAFE_IDENTIFIER_COLUMNS.has(column)) return '対象あり'
  if (column === 'detail_json') return '詳細あり（安全表示のため省略）'
  if (typeof value === 'string' && /(_at|At)$/.test(column)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('ja-JP', {
        dateStyle: 'short',
        timeStyle: 'medium',
        timeZone: 'Asia/Tokyo',
      }).format(date)
    }
  }
  return String(value)
}

function LogTable({ title, columns, rows, action }: {
  title: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** 行ごとの操作。返り値が null の行にはボタンを出さない。 */
  action?: (row: Record<string, unknown>) => ReactNode
}) {
  return (
    <details open className="rounded-lg border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer font-semibold">
        {title}<span className="ml-2 text-xs font-normal text-gray-500">取得件数 {rows.length}件</span>
      </summary>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">データなし</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                {columns.map((column) => <th key={column} className="px-3 py-2">{LOG_COLUMN_LABELS[column] ?? column}</th>)}
                {action && <th className="px-3 py-2">操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t border-gray-100">
                  {columns.map((column) => (
                    <td key={column} className="px-3 py-2 align-top">
                      {logValue(column, row[column])}
                    </td>
                  ))}
                  {action && <td className="px-3 py-2 align-top">{action(row)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}

export default function PlatformAdminLogsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [tenantId, setTenantId] = useState('')
  const [type, setType] = useState<'' | PlatformLogType>('')
  const [since, setSince] = useState('')
  const [limit, setLimit] = useState(50)
  const [logs, setLogs] = useState<PlatformLogs | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [retryResult, setRetryResult] = useState('')

  useEffect(() => {
    platformAdminApi.tenants()
      .then((res) => setTenants(res.data))
      .catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setLogs(null)
    try {
      const res = await platformAdminApi.logs({
        tenantId: tenantId || undefined,
        type: type || undefined,
        since: since ? new Date(`${since}T00:00:00+09:00`).toISOString() : undefined,
        limit,
      })
      setLogs(res.data)
    } catch (caught) {
      setError(platformAdminErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [tenantId, type, since, limit])

  useEffect(() => { void load() }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void load()
  }

  const retry = async (rowTenantId: string, webhookEventId: string) => {
    if (retrying || !window.confirm(
      'Webhookを再試行します。患者へのLINE送信が再実行される可能性があります。よろしいですか?',
    )) return
    setRetrying(webhookEventId)
    setError('')
    try {
      const res = await platformAdminApi.retryWebhookEvent(rowTenantId, webhookEventId)
      if (res.data.outcome !== 'completed') throw new Error('再試行を完了できませんでした。最新状態を確認してください。')
      setRetryResult(`再試行結果: ${res.data.outcome}`)
      await load()
    } catch (caught) {
      setError(platformAdminErrorMessage(caught))
    } finally {
      setRetrying('')
    }
  }

  /**
   * 再試行できるのは failed / dead-lettered の行だけ（バックエンドが他を400で拒否する）。
   * テナントは行自身の tenant_id を使い、無い行だけフィルタで選択中のテナントに頼る。
   * どちらも無ければテナントを特定できないのでボタンを出さない。
   */
  const retryAction = (row: Record<string, unknown>): ReactNode => {
    const retryable = row.status === 'failed' || Boolean(row.dead_lettered_at)
    const rowTenantId = typeof row.tenant_id === 'string' ? row.tenant_id : tenantId
    const webhookEventId = String(row.webhook_event_id ?? '')
    if (!retryable || !rowTenantId || !webhookEventId) return null
    return (
      <button
        type="button"
        onClick={() => void retry(rowTenantId, webhookEventId)}
        disabled={Boolean(retrying)}
        className="rounded-lg border border-purple-300 px-2 py-1 text-xs text-purple-800 hover:bg-purple-50 disabled:opacity-50"
      >
        {retrying === webhookEventId ? '再試行中...' : '再試行'}
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">ログ</h1>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm">
        <label htmlFor="log-tenant">テナント
          <select id="log-tenant" value={tenantId} onChange={(event) => setTenantId(event.target.value)} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="">全テナント</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>{tenant.tenantCode} / {tenant.displayName}</option>
            ))}
          </select>
        </label>
        <label htmlFor="log-type">種別
          <select id="log-type" value={type} onChange={(event) => setType(event.target.value as '' | PlatformLogType)} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2">
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label htmlFor="log-since">この日時以降
          <input id="log-since" type="date" value={since} onChange={(event) => setSince(event.target.value)} className="mt-1 block rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label htmlFor="log-limit">件数（最大200）
          <input id="log-limit" type="number" min={1} max={200} value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="mt-1 block w-28 rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <button type="submit" disabled={loading} className="rounded-lg bg-purple-700 px-4 py-2 font-medium text-white disabled:opacity-50">
          {loading ? '取得中...' : '再取得'}
        </button>
      </form>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {retryResult && <p className="text-sm text-green-700">再試行の結果 — {retryResult}</p>}

      {logs?.prescriptionEvents && (
        <LogTable
          title="処方せんイベント"
          columns={['created_at', 'tenant_id', 'line_account_id', 'submission_id', 'event_type', 'actor_type', 'from_status', 'to_status', 'id']}
          rows={logs.prescriptionEvents}
        />
      )}
      {logs?.webhookReceipts && (
        <LogTable
          title="Webhook受信"
          columns={['received_at', 'tenant_id', 'line_account_id', 'webhook_event_id', 'status', 'retry_count', 'dead_lettered_at']}
          rows={logs.webhookReceipts}
          action={retryAction}
        />
      )}
      {logs?.platformAdminAccess && (
        <LogTable
          title="全体管理者アクセス"
          columns={['created_at', 'platform_admin_id', 'tenant_id', 'action', 'resource_type', 'resource_id', 'detail_json', 'id']}
          rows={logs.platformAdminAccess}
        />
      )}
    </div>
  )
}
