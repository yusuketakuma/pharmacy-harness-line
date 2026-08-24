'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  DEFAULT_GRANT_MINUTES,
  MAX_GRANT_MINUTES,
  PHI_READ_SCOPE,
  platformAdminApi,
  platformAdminErrorMessage,
  type PlatformSupportGrant,
} from '@/lib/platform-admin-api'

/**
 * サポートモード（期限付きPHIアクセス）の開始フォームと、全ページ共通の
 * カウントダウンバナー。
 *
 * 開始フォームは現在のパスワードを再入力させる (step-up)。入力値はリクエスト
 * ボディで送るだけで、state から抜けた後はどこにも残さない — localStorage にも
 * URL にもログにも書かない。
 */

/** 開始/終了をまたいだページ間でバナーを更新するための合図。Context も
 *  ストアも要らない — 1本のイベントで足りる。 */
export const SUPPORT_GRANTS_CHANGED = 'lh-platform-admin-grants-changed'
export const SUPPORT_ACCESS_EXPIRED = 'lh-platform-admin-support-access-expired'

export function notifySupportGrantsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SUPPORT_GRANTS_CHANGED))
}

/**
 * バナーに出すテナント名の控え。グラント API はテナント ID しか返さないが、
 * 名前のためだけに全ページで `GET /tenants` を叩くと監査ログ (list_tenants) が
 * ページ遷移のたびに増える。開始時点で判っている名前を控えておき、無ければ
 * 安全な固定ラベルを出す。
 */
const TENANT_NAME_STORAGE_KEY = 'lh_platform_admin_tenant_names'

function tenantNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TENANT_NAME_STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

export function rememberTenantName(tenantId: string, name: string): void {
  if (typeof window === 'undefined' || !name) return
  localStorage.setItem(TENANT_NAME_STORAGE_KEY, JSON.stringify({ ...tenantNames(), [tenantId]: name }))
}

const DURATION_OPTIONS = [15, 30, 45, 60].filter((minutes) => minutes <= MAX_GRANT_MINUTES)

/** 残り時間を mm:ss で。期限切れは null。 */
function remaining(expiresAt: string, now: number): string | null {
  const left = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(left) || left <= 0) return null
  const total = Math.floor(left / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function SupportModeStartForm({ tenantId, tenantName, onStarted }: {
  tenantId: string
  tenantName?: string
  onStarted?: (grant: PlatformSupportGrant) => void
}) {
  const [reason, setReason] = useState('')
  const [ticketReference, setTicketReference] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_GRANT_MINUTES)
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const res = await platformAdminApi.startSupportGrant(tenantId, {
        reason,
        ticketReference: ticketReference || undefined,
        scopes: [PHI_READ_SCOPE],
        currentPassword,
        durationMinutes,
      })
      // 送信し終えたら即座に破棄する。
      setCurrentPassword('')
      if (tenantName) rememberTenantName(tenantId, tenantName)
      notifySupportGrantsChanged()
      onStarted?.(res.data)
    } catch (caught) {
      setError(platformAdminErrorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-gray-600">
        患者情報（個人の診療記録）の閲覧には、理由と現在のパスワードの再入力が必要です。
        許可は指定した時間で自動的に切れます。
      </p>
      <label className="block text-sm" htmlFor="support-reason">理由（必須）
        <input
          id="support-reason"
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={10}
          maxLength={500}
          required
          className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2"
        />
        <span className="mt-1 block text-xs text-gray-500">対象と調査目的を10文字以上で記録してください。</span>
      </label>
      <label className="block text-sm" htmlFor="support-ticket">チケット番号（任意）
        <input
          id="support-ticket"
          type="text"
          value={ticketReference}
          onChange={(event) => setTicketReference(event.target.value)}
          className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2"
        />
      </label>
      <label className="block text-sm" htmlFor="support-duration">有効時間
        <select
          id="support-duration"
          value={durationMinutes}
          onChange={(event) => setDurationMinutes(Number(event.target.value))}
          className="mt-1 block w-full max-w-md rounded-lg border border-gray-300 bg-white px-3 py-2"
        >
          {DURATION_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>{minutes}分</option>
          ))}
        </select>
      </label>
      <label className="block text-sm" htmlFor="support-password">現在のパスワード（再確認）
        <input
          id="support-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
          className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2"
        />
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg bg-purple-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? '開始中...' : 'サポートモード開始'}
      </button>
    </form>
  )
}

/**
 * 有効なグラントがある間だけ出るカウントダウン。1秒ごとに再描画し、
 * 期限が切れた行は自然に消える。「全体管理者モード」バナーの置き換えではなく
 * 追加で出す。
 */
export function SupportModeBanner() {
  const [grants, setGrants] = useState<PlatformSupportGrant[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [loadError, setLoadError] = useState('')
  const [ending, setEnding] = useState('')

  const reload = useCallback(() => {
    platformAdminApi.activeSupportGrants()
      .then((res) => {
        setGrants(res.data ?? [])
        setLoadError('')
      })
      .catch(() => setLoadError('サポートモード状態を確認できません。患者情報の操作を中止し、再読み込みしてください。'))
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener(SUPPORT_GRANTS_CHANGED, reload)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.removeEventListener(SUPPORT_GRANTS_CHANGED, reload)
      clearInterval(tick)
    }
  }, [reload])

  useEffect(() => {
    if (!grants.some((grant) => remaining(grant.expires_at, now) === null)) return
    setGrants((current) => current.filter((grant) => remaining(grant.expires_at, now) !== null))
    window.dispatchEvent(new Event(SUPPORT_ACCESS_EXPIRED))
  }, [grants, now])

  const end = async (grantId: string) => {
    if (ending || !window.confirm('サポートモードを終了しますか？患者情報の閲覧は直ちに終了します。')) return
    setEnding(grantId)
    try {
      await platformAdminApi.endSupportGrant(grantId)
      setLoadError('')
      // 自分のリスナーも拾うので、ここで reload() を呼ぶ必要はない。
      notifySupportGrantsChanged()
    } catch {
      setLoadError('サポートモードを終了できませんでした。患者情報の操作を中止し、再読み込みしてください。')
    } finally {
      setEnding('')
    }
  }

  const live = grants
    .map((grant) => ({ grant, left: remaining(grant.expires_at, now) }))
    .filter((row): row is { grant: PlatformSupportGrant; left: string } => row.left !== null)
  if (live.length === 0 && !loadError) return null

  const names = tenantNames()
  return (
    <>
      {loadError && <div role="alert" className="bg-red-700 px-4 py-2 text-center text-sm font-bold text-white">{loadError}</div>}
      {live.length > 0 && (
        <div className="bg-amber-500 px-4 py-2 text-sm font-bold text-amber-950">
          {live.map(({ grant, left }) => (
            <div key={grant.id} className="flex flex-wrap items-center justify-center gap-3">
              <span>サポートモード: {names[grant.tenant_id] ?? '対象テナント'} — 残り {left}</span>
              <button
                type="button"
                onClick={() => void end(grant.id)}
                disabled={Boolean(ending)}
                className="min-h-11 rounded border border-amber-900 px-3 text-xs font-medium hover:bg-amber-400 disabled:opacity-50"
              >
                {ending === grant.id ? '終了中...' : '終了'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** 403（グラント無し）に当たったページが出す誘導。開始フォームをその場に出す。 */
export function SupportModeRequired({ tenantId, onStarted }: {
  tenantId: string
  onStarted?: (grant: PlatformSupportGrant) => void
}) {
  return (
    <section role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h2 className="mb-2 font-semibold text-amber-900">
        このテナントの患者情報を見るにはサポートモードを開始してください
      </h2>
      <SupportModeStartForm tenantId={tenantId} onStarted={onStarted} />
    </section>
  )
}
