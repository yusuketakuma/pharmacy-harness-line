'use client'
import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  platformAdminApi,
  type PlatformLineProbe,
  type PlatformLineStatus,
  type PlatformStaffMember,
  type PlatformTenantDetail,
  type PlatformTenantHealth,
} from '@/lib/platform-admin-api'
import { SupportModeStartForm } from '@/components/platform-admin/support-mode'

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const ymd = (value: string | null) => value
  ? new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'Asia/Tokyo',
    }).format(new Date(value))
  : '—'

/** GET /tenants/:id/health — 稼働状況のスナップショット。 */
function HealthPanel({ tenantId }: { tenantId: string }) {
  const [health, setHealth] = useState<PlatformTenantHealth | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    platformAdminApi.tenantHealth(tenantId)
      .then((res) => setHealth(res.data))
      .catch((caught: Error) => setError(caught.message))
  }, [tenantId])

  return (
    <Panel title="ヘルス">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!health && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {health && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt className="text-gray-500">Webhook成功(24h)</dt><dd>{health.webhook24h.success}</dd></div>
            <div>
              <dt className="text-gray-500">Webhook失敗(24h)</dt>
              <dd>{health.webhook24h.failed}</dd>
              {health.webhook24h.failed > 0 && <Link href="/platform-admin/logs" className="text-xs text-purple-800 underline">Webhookログを確認</Link>}
            </div>
            <div><dt className="text-gray-500">有効スタッフ数</dt><dd>{health.activeStaffCount}</dd></div>
            <div><dt className="text-gray-500">有効セッション数</dt><dd>{health.activeSessionCount}</dd></div>
            <div className="col-span-2"><dt className="text-gray-500">最終管理者ログイン</dt><dd>{ymd(health.lastAdminLoginAt)}</dd></div>
          </dl>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">LINEアカウント</th>
                  <th className="px-3 py-2">有効</th>
                  <th className="px-3 py-2">チャネル識別情報</th>
                  <th className="px-3 py-2">最終Webhook受信</th>
                </tr>
              </thead>
              <tbody>
                {health.lineAccounts.map((account) => (
                  <tr key={account.id} className="border-t border-gray-100">
                    <td className="px-3 py-2">{account.name}<span className="ml-2 font-mono text-xs text-gray-500">{account.id}</span></td>
                    <td className="px-3 py-2">{account.isActive ? '有効' : '無効'}</td>
                    <td className="px-3 py-2">{account.hasChannelIdentity ? 'あり' : 'なし'}</td>
                    <td className="px-3 py-2">{ymd(account.lastWebhookAt)}</td>
                  </tr>
                ))}
                {health.lineAccounts.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">LINEアカウントがありません</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  )
}

/** GET /tenants/:id/line-status + 行ごとの接続テスト。秘密情報は返らない。 */
function LinePanel({ tenantId }: { tenantId: string }) {
  const [accounts, setAccounts] = useState<PlatformLineStatus[] | null>(null)
  const [probes, setProbes] = useState<Record<string, PlatformLineProbe | 'testing'>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    platformAdminApi.lineStatus(tenantId)
      .then((res) => setAccounts(res.data))
      .catch((caught: Error) => setError(caught.message))
  }, [tenantId])

  const test = async (lineAccountId: string) => {
    setProbes((current) => ({ ...current, [lineAccountId]: 'testing' }))
    try {
      // ok:false も HTTP 200 で返る（接続失敗は診断の正常な結果）。
      const res = await platformAdminApi.testLineConnection(tenantId, lineAccountId)
      setProbes((current) => ({ ...current, [lineAccountId]: res.data }))
    } catch (caught) {
      setProbes((current) => ({
        ...current,
        [lineAccountId]: { ok: false, error: caught instanceof Error ? caught.message : '失敗' },
      }))
    }
  }

  return (
    <Panel title="LINE連携">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!accounts && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {accounts && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">チャネルID</th>
                <th className="px-3 py-2">有効</th>
                <th className="px-3 py-2">Bot識別</th>
                <th className="px-3 py-2">認証情報</th>
                <th className="px-3 py-2">最終Webhook受信</th>
                <th className="px-3 py-2">接続テスト</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const probe = probes[account.id]
                return (
                  <tr key={account.id} className="border-t border-gray-100">
                    <td className="px-3 py-2">{account.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{account.channelId}</td>
                    <td className="px-3 py-2">{account.isActive ? '有効' : '無効'}</td>
                    <td className="px-3 py-2">{account.hasBotIdentity ? 'あり' : 'なし'}</td>
                    <td className="px-3 py-2">{account.hasEncryptedCredential ? 'あり' : 'なし'}</td>
                    <td className="px-3 py-2">{ymd(account.lastWebhookReceivedAt)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => void test(account.id)}
                        disabled={probe === 'testing'}
                        className="rounded-lg border border-purple-300 px-2 py-1 text-xs text-purple-800 hover:bg-purple-50 disabled:opacity-50"
                      >
                        {probe === 'testing' ? 'テスト中...' : '接続テスト'}
                      </button>
                      {probe && probe !== 'testing' && (
                        <span className={`ml-2 text-xs ${probe.ok ? 'text-green-700' : 'text-red-600'}`}>
                          {probe.ok ? `OK ${probe.displayName ?? probe.botUserId}` : probe.error}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {accounts.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">LINEアカウントがありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/** GET /tenants/:id/staff + 無効化 / 全セッション失効。 */
function StaffPanel({ tenantId }: { tenantId: string }) {
  const [staff, setStaff] = useState<PlatformStaffMember[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState('')

  const load = useCallback(() => {
    platformAdminApi.staff(tenantId)
      .then((res) => setStaff(res.data))
      .catch((caught: Error) => setError(caught.message))
  }, [tenantId])

  useEffect(load, [load])

  const disable = async (member: PlatformStaffMember) => {
    // staff_members はプラットフォーム横断。ここでの無効化は所属する全テナントに効く。
    if (!window.confirm(`${member.name} を無効化します。所属する全テナントでログインできなくなり、このテナントのセッションは失効します。よろしいですか?`)) return
    if (working) return
    setWorking(member.staffId)
    setError('')
    setNotice('')
    try {
      const res = await platformAdminApi.disableStaff(tenantId, member.staffId)
      setNotice(`${member.name} を無効化しました（セッション ${res.data.sessionsRevoked} 件失効）`)
      load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無効化に失敗しました')
    } finally {
      setWorking('')
    }
  }

  const revokeAll = async () => {
    if (!window.confirm('このテナントの管理画面セッションをすべて失効させます。よろしいですか?')) return
    if (working) return
    setWorking('all')
    setError('')
    setNotice('')
    try {
      const res = await platformAdminApi.revokeTenantSessions(tenantId)
      setNotice(`${res.data.revoked} 件のセッションを失効させました`)
      load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '失効に失敗しました')
    } finally {
      setWorking('')
    }
  }

  return (
    <Panel title="スタッフ・セッション">
      {error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-2 text-sm text-green-700">{notice}</p>}
      {!staff && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {staff && (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">氏名</th>
                  <th className="px-3 py-2">メール</th>
                  <th className="px-3 py-2">役割</th>
                  <th className="px-3 py-2">状態</th>
                  <th className="px-3 py-2">有効セッション</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((member) => (
                  <tr key={member.staffId} className="border-t border-gray-100">
                    <td className="px-3 py-2">{member.name}</td>
                    <td className="px-3 py-2">{member.email ?? '—'}</td>
                    <td className="px-3 py-2">{member.role}</td>
                    <td className="px-3 py-2">
                      {member.isActive ? '有効' : '無効'}
                      {!member.membershipActive && <span className="ml-1 text-xs text-gray-500">(所属停止)</span>}
                    </td>
                    <td className="px-3 py-2">{member.activeSessionCount}</td>
                    <td className="px-3 py-2">
                      {member.isActive && (
                        <button
                          type="button"
                          onClick={() => void disable(member)}
                          disabled={Boolean(working)}
                          className="rounded-lg border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          {working === member.staffId ? '無効化中...' : '無効化'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {staff.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">スタッフがいません</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => void revokeAll()}
            disabled={Boolean(working)}
            className="mt-3 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
          >
            {working === 'all' ? '失効中...' : '全セッション失効'}
          </button>
        </>
      )}
    </Panel>
  )
}

function OutboundPanel({ tenantId, outboundMessagingPausedAt: initialPausedAt }: {
  tenantId: string
  outboundMessagingPausedAt: string | null
}) {
  const [outboundMessagingPausedAt, setOutboundMessagingPausedAt] = useState(initialPausedAt)
  const [changing, setChanging] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const set = async (paused: boolean) => {
    const action = paused ? '一時停止' : '再開'
    if (changing || !window.confirm(`自動配信を${action}します。よろしいですか?`)) return
    setChanging(true)
    setError('')
    setResult('')
    try {
      const res = await platformAdminApi.setOutboundMessaging(tenantId, paused)
      setOutboundMessagingPausedAt(res.data.outboundMessagingPausedAt)
      setResult(`送信を${action}しました`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '切り替えに失敗しました')
    } finally {
      setChanging(false)
    }
  }

  return (
    <Panel title="患者向けLINE送信の一時停止">
      <p className="mb-3 text-sm text-gray-600">
        自動配信（処方せん通知・服薬フォロー等）のみを止めます。Webhookの受信は続きます。
      </p>
      <p className="mb-3 text-sm font-medium">
        現在: {outboundMessagingPausedAt
          ? `一時停止中（${ymd(outboundMessagingPausedAt)} から）`
          : '送信中'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void set(true)}
          disabled={changing || Boolean(outboundMessagingPausedAt)}
          className="rounded-lg border border-amber-400 px-3 py-2 text-sm text-amber-900 hover:bg-amber-50 disabled:opacity-50"
        >
          送信を一時停止
        </button>
        <button
          type="button"
          onClick={() => void set(false)}
          disabled={changing || !outboundMessagingPausedAt}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          送信を再開
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      {result && <p className="mt-2 text-sm text-green-700">{result}</p>}
    </Panel>
  )
}

function TenantDetail({ tenantId }: { tenantId: string }) {
  const router = useRouter()
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
    if (status === 'suspended' && tenant.status !== 'suspended' && !window.confirm(
      'テナントを停止すると管理画面へのログインと患者向けLINE送信に影響します。停止しますか？',
    )) return
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <Link href="/platform-admin/tenants" className="text-sm text-purple-800 underline">← テナント一覧</Link>
        <h1 className="mt-2 text-xl font-bold">{tenant.displayName}</h1>
        </div>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">最新情報を再取得</button>
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

      <Panel title="サポートモード">
        <SupportModeStartForm
          tenantId={tenant.id}
          tenantName={tenant.displayName}
          onStarted={() => router.push(`/platform-admin/tenants/patients?id=${encodeURIComponent(tenant.id)}`)}
        />
      </Panel>

      <HealthPanel tenantId={tenant.id} />
      <LinePanel tenantId={tenant.id} />
      <StaffPanel tenantId={tenant.id} />
      <OutboundPanel
        tenantId={tenant.id}
        outboundMessagingPausedAt={tenant.outboundMessagingPausedAt}
      />

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
