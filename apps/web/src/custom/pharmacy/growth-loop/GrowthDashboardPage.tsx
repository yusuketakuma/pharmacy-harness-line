'use client'

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { pharmacyGrowthApi } from './api'

type Dashboard = Extract<Awaited<ReturnType<typeof pharmacyGrowthApi.dashboard>>, { success: true }>['data']
type MedicalSource = Extract<Awaited<ReturnType<typeof pharmacyGrowthApi.sources>>, { success: true }>['data'][number]
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export function isCurrentDashboardRequest(
  request: { id: number; key: string },
  current: { id: number; key: string },
): boolean {
  return request.id === current.id && request.key === current.key
}

type SourceAccount = { generation: number; accountId: string }
type SourceRequest = SourceAccount & { id: number }

export function nextSourceAccount(current: SourceAccount, accountId: string): SourceAccount {
  return current.accountId === accountId
    ? current
    : { generation: current.generation + 1, accountId }
}

export function isCurrentSourceAccount(
  operation: SourceAccount,
  current: SourceAccount,
): boolean {
  return operation.generation === current.generation && operation.accountId === current.accountId
}

export function nextSourceRequest(current: Pick<SourceRequest, 'id'>, account: SourceAccount): SourceRequest {
  return { id: current.id + 1, ...account }
}

export function isCurrentSourceRequest(request: SourceRequest, current: SourceRequest): boolean {
  return request.id === current.id && isCurrentSourceAccount(request, current)
}

export function monthRangeJst(month: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  const monthNumber = match ? Number(match[2]) : 0
  if (!match || monthNumber < 1 || monthNumber > 12) throw new Error('invalid month')
  const year = Number(match[1])
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - JST_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(year, monthNumber, 1) - JST_OFFSET_MS).toISOString(),
  }
}

export function notificationOutcomeCount(counts: Record<string, number>, outcome: string): number {
  return Object.entries(counts).reduce(
    (total, [key, count]) => total + (key.endsWith(`:${outcome}`) ? count : 0),
    0,
  )
}

export function hasMessagingRecords(counts: {
  sent: number
  received: number
  attempted: number
  reconciliationRequired: number
}): boolean {
  return counts.sent + counts.received + counts.attempted + counts.reconciliationRequired > 0
}

function Card({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><p className="text-sm text-gray-500">{label}</p><p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>{note && <p className="mt-1 text-xs text-gray-500">{note}</p>}</div>
}

function rate(numerator: number, denominator: number): string {
  return denominator ? `${Math.round((numerator / denominator) * 100)}%` : '—'
}

function formatJstDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
  }).format(new Date(value))
}

export function MedicalSourceManager({
  sources,
  busy,
  onCreate,
  onSetActive,
}: {
  sources: Array<Pick<MedicalSource, 'id' | 'display_name' | 'classification' | 'is_active'>>
  busy: boolean
  onCreate: (name: string, classification: 'primary' | 'other') => Promise<void>
  onSetActive: (id: string, active: boolean) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [classification, setClassification] = useState<'primary' | 'other'>('other')
  return <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
    <h2 className="font-semibold text-gray-800">発行元マスター</h2>
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-52 flex-1 text-sm">新規発行元<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
      <label className="text-sm">区分<select value={classification} onChange={(event) => setClassification(event.target.value as 'primary' | 'other')} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="primary">主な発行元</option><option value="other">その他</option></select></label>
      <button type="button" disabled={busy || !name.trim()} onClick={() => void onCreate(name.trim(), classification).then(() => setName(''))} className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">追加</button>
    </div>
    <ul className="mt-4 divide-y divide-gray-100">
      {sources.map((source) => <li key={source.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span>{source.display_name} <span className="text-gray-500">({source.classification === 'primary' ? '主な発行元' : 'その他'})</span></span><button type="button" disabled={busy} onClick={() => void onSetActive(source.id, source.is_active !== 1)} className="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-50">{source.is_active === 1 ? '無効にする' : '有効に戻す'}</button></li>)}
      {sources.length === 0 && <li className="py-3 text-sm text-gray-500">発行元はまだ登録されていません。</li>}
    </ul>
  </section>
}

export default function GrowthDashboardPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [data, setData] = useState<Dashboard | null>(null)
  const [dataMonth, setDataMonth] = useState('')
  const [dataAccountId, setDataAccountId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sources, setSources] = useState<MedicalSource[]>([])
  const [sourceAccountId, setSourceAccountId] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [sourceActionError, setSourceActionError] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [month, setMonth] = useState(() => new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 7))
  const selectionKey = `${selectedAccountId ?? ''}\u0000${month}`
  const selectedSourceAccountId = selectedAccountId ?? ''
  const latestSourceAccount = useRef<SourceAccount>({ generation: 0, accountId: selectedSourceAccountId })
  const latestSourceRequest = useRef<SourceRequest>({ id: 0, ...latestSourceAccount.current })
  const latestRequest = useRef({ id: 0, key: selectionKey })
  useLayoutEffect(() => {
    if (latestRequest.current.key !== selectionKey) {
      latestRequest.current = { id: latestRequest.current.id + 1, key: selectionKey }
      setError('')
    }
    const nextAccount = nextSourceAccount(latestSourceAccount.current, selectedSourceAccountId)
    if (nextAccount !== latestSourceAccount.current) {
      latestSourceAccount.current = nextAccount
      latestSourceRequest.current = nextSourceRequest(latestSourceRequest.current, nextAccount)
      setSourceBusy(false)
      setSourceError('')
      setSourceActionError('')
    }
  }, [selectedSourceAccountId, selectionKey])

  const load = useCallback(async () => {
    if (!selectedAccountId || latestRequest.current.key !== selectionKey) return
    const request = { id: latestRequest.current.id + 1, key: selectionKey }
    latestRequest.current = request
    const sourceRequest = nextSourceRequest(latestSourceRequest.current, latestSourceAccount.current)
    latestSourceRequest.current = sourceRequest
    setLoading(true); setError('')
    try {
      const range = monthRangeJst(month)
      const [dashboardResult, sourcesResult] = await Promise.allSettled([
        pharmacyGrowthApi.dashboard(selectedAccountId, range.from, range.to),
        pharmacyGrowthApi.sources(selectedAccountId),
      ])
      if (isCurrentSourceRequest(sourceRequest, latestSourceRequest.current)) {
        if (sourcesResult.status === 'fulfilled' && sourcesResult.value.success) {
          setSources(sourcesResult.value.data)
          setSourceAccountId(selectedAccountId)
          setSourceError('')
        } else {
          setSourceError('発行元マスターを取得できませんでした。再読み込みしてください。')
        }
      }
      if (!isCurrentDashboardRequest(request, latestRequest.current)) return
      if (dashboardResult.status === 'rejected') throw dashboardResult.reason
      const response = dashboardResult.value
      if (!response.success) throw new Error(response.error)
      setData(response.data as Dashboard)
      setDataMonth(month)
      setDataAccountId(selectedAccountId)
    } catch {
      if (isCurrentDashboardRequest(request, latestRequest.current)) {
        setError('薬局統計の集計を取得できませんでした。薬局モードと権限を確認してください。')
      }
    } finally {
      if (isCurrentDashboardRequest(request, latestRequest.current)) setLoading(false)
    }
  }, [month, selectedAccountId, selectionKey])

  useEffect(() => { void load() }, [load])

  const refreshSources = useCallback(async (accountId: string, operationAccount: SourceAccount) => {
    if (!isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) return
    const sourceRequest = nextSourceRequest(latestSourceRequest.current, operationAccount)
    latestSourceRequest.current = sourceRequest
    try {
      const response = await pharmacyGrowthApi.sources(accountId)
      if (!isCurrentSourceRequest(sourceRequest, latestSourceRequest.current)) return
      if (!response.success) throw new Error(response.error)
      setSources(response.data)
      setSourceAccountId(accountId)
      setSourceError('')
    } catch {
      if (isCurrentSourceRequest(sourceRequest, latestSourceRequest.current)) {
        setSourceError('変更は保存されましたが、発行元マスターを再取得できませんでした。再読み込みしてください。')
      }
    }
  }, [])

  const createSource = async (name: string, classification: 'primary' | 'other') => {
    if (!selectedAccountId || latestSourceAccount.current.accountId !== selectedAccountId) return
    const operationAccount = latestSourceAccount.current
    setSourceBusy(true); setSourceActionError('')
    try {
      const response = await pharmacyGrowthApi.createSource(selectedAccountId, { displayName: name, classification })
      if (!response.success) throw new Error(response.error)
      if (!isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) return
      await refreshSources(selectedAccountId, operationAccount)
    } catch {
      if (isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) setSourceActionError('発行元を追加できませんでした。')
    } finally {
      if (isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) setSourceBusy(false)
    }
  }

  const setSourceActive = async (sourceId: string, active: boolean) => {
    if (!selectedAccountId || latestSourceAccount.current.accountId !== selectedAccountId) return
    const operationAccount = latestSourceAccount.current
    setSourceBusy(true); setSourceActionError('')
    try {
      const response = await pharmacyGrowthApi.setSourceActive(selectedAccountId, sourceId, active)
      if (!response.success) throw new Error(response.error)
      if (!isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) return
      await refreshSources(selectedAccountId, operationAccount)
    } catch {
      if (isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) setSourceActionError('発行元の状態を更新できませんでした。')
    } finally {
      if (isCurrentSourceAccount(operationAccount, latestSourceAccount.current)) setSourceBusy(false)
    }
  }

  if (accountLoading) return <p role="status" className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>
  if (loading && (!data || dataMonth !== month || dataAccountId !== selectedAccountId)) return <p role="status" className="py-10 text-center text-gray-500">集計を読み込み中...</p>
  return <main className="mx-auto max-w-7xl space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-gray-900">薬局統計</h1><p className="mt-1 text-sm text-gray-500">受付入口、約束時刻、期限確認を薬局単位で確認します。</p></div><div className="flex items-end gap-2"><label className="text-sm text-gray-700">集計月<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2" /></label><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button></div></div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {data && dataMonth === month && dataAccountId === selectedAccountId && <>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">入口</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="初回友だち追加" value={data.entry.firstTimeFollows} />
          <Card label="計測可能な友だち追加" value={data.entry.measurableFollows} />
          <Card label="初回送信率" value={rate(data.entry.firstSubmissionRate.numerator, data.entry.firstSubmissionRate.denominator)} note={`${data.entry.firstSubmissionRate.numerator}/${data.entry.firstSubmissionRate.denominator}（成熟 ${data.entry.firstSubmissionRate.matureCohort} / 未成熟 ${data.entry.firstSubmissionRate.immatureCohort}）`} />
          <Card label="2回目送信率" value={rate(data.entry.secondSubmissionRate.numerator, data.entry.secondSubmissionRate.denominator)} note={`${data.entry.secondSubmissionRate.numerator}/${data.entry.secondSubmissionRate.denominator}（成熟 ${data.entry.secondSubmissionRate.matureCohort} / 未成熟 ${data.entry.secondSubmissionRate.immatureCohort}）`} />
        </div>
        <p className="mt-2 text-xs text-gray-500">成熟は、選択月の後にも送信行動を観測できる期間が経過した対象です。未成熟は集計待ちの対象です。</p>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">面分業</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card label="主な発行元" value={data.sources.primary} />
          <Card label="その他の発行元" value={data.sources.other} note={`その他 ÷ 分類済み: ${data.sources.otherShare === null ? '—' : `${Math.round(data.sources.otherShare * 100)}%`}`} />
          <Card label="発行元不明" value={data.sources.unknown} />
          <Card label="分類済み分母" value={data.sources.knownDenominator} />
          <Card label="発行元分類率" value={data.sources.attributionCoverage === null ? '—' : `${Math.round(data.sources.attributionCoverage * 100)}%`} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">約束</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="準備予定あり" value={data.promises.promised} />
          <Card label="予定内率" value={data.promises.onTimeRate === null ? '—' : `${Math.round(data.promises.onTimeRate * 100)}%`} note={`猶予 ${data.promises.graceMinutes}分`} />
          <Card label="遅延件数" value={data.promises.late} />
          <Card label="準備完了・予定なし" value={data.promises.promiseWithoutQuote} />
          <Card label="遅延の中央値（分）" value={data.promises.p50LatenessMinutes === null ? '—' : Math.round(data.promises.p50LatenessMinutes)} />
          <Card label="遅延の90%地点（分）" value={data.promises.p90LatenessMinutes === null ? '—' : Math.round(data.promises.p90LatenessMinutes)} />
          <Card label="予定時刻の版数" value={data.promises.promiseRevisionCount} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">使用期限</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card label="確認済み使用期限" value={data.validity.verified} />
          <Card label="期限前日通知" value={data.validity.reminderSent} />
          <Card label="期限前日通知後に期限内完了" value={data.validity.reminderClosedInTime} />
          <Card label="期限確認が必要" value={data.validity.expiredReviewRequired} />
          <Card label="期限切れ確認済み" value={data.validity.confirmedExpired} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">通知</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="受付・準備通知" value={data.notifications.counts['transactional_care:sent'] ?? 0} />
          <Card label="フォロー通知" value={data.notifications.counts['followup_care:sent'] ?? 0} />
          <Card label="継続通知" value={data.notifications.counts['continuity:sent'] ?? 0} />
          <Card label="能動的なお知らせ" value={data.notifications.counts['proactive_noncare:sent'] ?? 0} />
          <Card label="手動送信" value={data.notifications.counts['manual:sent'] ?? 0} />
          <Card label="能動的なお知らせ: 月間上限で見送り" value={data.notifications.proactiveCapBlocked} />
          <Card label="能動通知の試行" value={data.notifications.proactiveAttempts} />
          <Card label="送信試行" value={data.notifications.attempted} />
          <Card label="通知送信済み" value={notificationOutcomeCount(data.notifications.counts, 'sent')} />
          <Card label="通知処理中" value={notificationOutcomeCount(data.notifications.counts, 'attempted')} />
          <Card label="通知失敗" value={notificationOutcomeCount(data.notifications.counts, 'failed')} />
          <Card label="通知見送り" value={notificationOutcomeCount(data.notifications.counts, 'blocked')} />
          <Card label="要確認（24時間超）" value={data.notifications.reconciliationRequired} note="自動再送せず、配信結果を確認してください" />
          <Card label="監視状態" value={data.notifications.alertState === 'alert_only' ? '警告のみ' : '設定保留（自動停止なし）'} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">メッセージ</h2>
        {!hasMessagingRecords(data.messaging) &&
          <p className="mb-2 text-sm text-gray-500">この期間のメッセージ記録はありません。</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="送信記録数（テスト除外）" value={data.messaging.sent} />
          <Card label="受信記録数" value={data.messaging.received} />
          <Card label="手動送信" value={data.messaging.manual} />
          <Card label="自動送信" value={data.messaging.automated} />
          <Card label="push送信" value={data.messaging.push} />
          <Card label="reply送信" value={data.messaging.reply} />
          <Card label="LINE送信処理中" value={data.messaging.attempted} />
          <Card label="LINE送信要確認" value={data.messaging.reconciliationRequired} note="送信経路ごとの再送期限を超えた結果不明の送信です" />
          <Card label="一意の対応者数" value={data.messaging.uniqueCorrespondents} />
          <Card label="送信元未確認" value={data.messaging.sourceUnverified} />
          <Card label="配信種別未確認" value={data.messaging.deliveryUnverified} />
          <Card label="旧記録（アカウント未確定）" value="未確認" note="現在の所属から推測して数え直しません" />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">LINEブロック監視</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Card label="送信対象友だち" value={data.unfollow.exposedFriends} />
          <Card label="24時間以内のブロック" value={data.unfollow.within24h} />
          <Card label="72時間以内のブロック" value={data.unfollow.within72h} />
          <Card label="サンプル数" value={data.unfollow.sampleSize} />
        </div>
        <p className="mt-2 text-xs text-gray-500">推定される時間的関連: {data.unfollow.interpretation}</p>
      </section>
      {sourceActionError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{sourceActionError}</p>}
      {sourceError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{sourceError}</p>}
      {sourceAccountId === selectedAccountId && !sourceError && <MedicalSourceManager sources={sources} busy={sourceBusy} onCreate={createSource} onSetActive={setSourceActive} />}
      <p className="text-xs text-gray-500">対象期間: {formatJstDate(data.from)} 〜 {formatJstDate(data.to)}（日本時間）。患者単位の情報は表示せず、すべて薬局アカウント内で集計しています。</p>
    </>}
  </main>
}
