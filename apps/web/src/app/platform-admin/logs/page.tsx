'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  platformAdminApi,
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

function LogTable({ title, columns, rows }: {
  title: string
  columns: string[]
  rows: Array<Record<string, unknown>>
}) {
  return (
    <details open className="rounded-lg border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer font-semibold">
        {title}<span className="ml-2 text-xs font-normal text-gray-500">{rows.length}件</span>
      </summary>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">データなし</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>{columns.map((column) => <th key={column} className="px-3 py-2">{column}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t border-gray-100">
                  {columns.map((column) => (
                    <td key={column} className="px-3 py-2 align-top">
                      {row[column] === null || row[column] === undefined ? '—' : String(row[column])}
                    </td>
                  ))}
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

  useEffect(() => {
    platformAdminApi.tenants()
      .then((res) => setTenants(res.data))
      .catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await platformAdminApi.logs({
        tenantId: tenantId || undefined,
        type: type || undefined,
        since: since || undefined,
        limit,
      })
      setLogs(res.data)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [tenantId, type, since, limit])

  useEffect(() => { void load() }, [load])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void load()
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
