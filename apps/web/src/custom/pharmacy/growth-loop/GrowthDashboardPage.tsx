'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'

type Dashboard = Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.dashboard>>, { success: true }>['data']
type MedicalSource = Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.sources>>, { success: true }>['data'][number]
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

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

function Card({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><p className="text-sm text-gray-500">{label}</p><p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>{note && <p className="mt-1 text-xs text-gray-500">{note}</p>}</div>
}

function rate(numerator: number, denominator: number): string {
  return denominator ? `${Math.round((numerator / denominator) * 100)}%` : '—'
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sources, setSources] = useState<MedicalSource[]>([])
  const [sourceBusy, setSourceBusy] = useState(false)
  const [month, setMonth] = useState(() => new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 7))

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true); setError('')
    try {
      const range = monthRangeJst(month)
      const [response, sourceResponse] = await Promise.all([
        api.pharmacyGrowth.dashboard(selectedAccountId, range.from, range.to),
        api.pharmacyGrowth.sources(selectedAccountId),
      ])
      if (!response.success) throw new Error(response.error)
      setData(response.data as Dashboard)
      setSources(sourceResponse.success ? sourceResponse.data : [])
    } catch {
      setError('薬局Growth Loopの集計を取得できませんでした。薬局モードと権限を確認してください。')
    } finally { setLoading(false) }
  }, [month, selectedAccountId])

  useEffect(() => { void load() }, [load])

  const createSource = async (name: string, classification: 'primary' | 'other') => {
    if (!selectedAccountId) return
    setSourceBusy(true); setError('')
    try {
      const response = await api.pharmacyGrowth.createSource(selectedAccountId, { displayName: name, classification })
      if (!response.success) throw new Error(response.error)
      await load()
    } catch { setError('発行元を追加できませんでした。') } finally { setSourceBusy(false) }
  }

  const setSourceActive = async (sourceId: string, active: boolean) => {
    if (!selectedAccountId) return
    setSourceBusy(true); setError('')
    try {
      const response = await api.pharmacyGrowth.setSourceActive(selectedAccountId, sourceId, active)
      if (!response.success) throw new Error(response.error)
      await load()
    } catch { setError('発行元の状態を更新できませんでした。') } finally { setSourceBusy(false) }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>
  if (loading && !data) return <p className="py-10 text-center text-gray-500">集計を読み込み中...</p>
  return <main className="mx-auto max-w-7xl space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-gray-900">薬局 Growth Loop</h1><p className="mt-1 text-sm text-gray-500">受付入口、約束時刻、期限確認を薬局単位で確認します。</p></div><div className="flex items-end gap-2"><label className="text-sm text-gray-700">集計月<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2" /></label><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button></div></div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {data && <>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">入口</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="初回友だち追加" value={data.entry.firstTimeFollows} />
          <Card label="計測可能な友だち追加" value={data.entry.measurableFollows} />
          <Card label="初回送信率" value={rate(data.entry.firstSubmissionRate.numerator, data.entry.firstSubmissionRate.denominator)} note={`${data.entry.firstSubmissionRate.numerator}/${data.entry.firstSubmissionRate.denominator}（成熟 ${data.entry.firstSubmissionRate.matureCohort} / 未成熟 ${data.entry.firstSubmissionRate.immatureCohort}）`} />
          <Card label="2回目送信率" value={rate(data.entry.secondSubmissionRate.numerator, data.entry.secondSubmissionRate.denominator)} note={`${data.entry.secondSubmissionRate.numerator}/${data.entry.secondSubmissionRate.denominator}（成熟 ${data.entry.secondSubmissionRate.matureCohort} / 未成熟 ${data.entry.secondSubmissionRate.immatureCohort}）`} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">面分業</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card label="主な発行元" value={data.sources.primary} />
          <Card label="その他の発行元" value={data.sources.other} note={`other / (primary + other): ${data.sources.otherShare === null ? '—' : `${Math.round(data.sources.otherShare * 100)}%`}`} />
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
          <Card label="p50遅延（分）" value={data.promises.p50LatenessMinutes === null ? '—' : Math.round(data.promises.p50LatenessMinutes)} />
          <Card label="p90遅延（分）" value={data.promises.p90LatenessMinutes === null ? '—' : Math.round(data.promises.p90LatenessMinutes)} />
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
          <Card label="通知上限で停止" value={data.notifications.proactiveCapBlocked} />
          <Card label="能動通知の試行" value={data.notifications.proactiveAttempts} />
          <Card label="送信試行" value={data.notifications.attempted} />
          <Card label="監視状態" value={data.notifications.alertState === 'alert_only' ? '警告のみ' : '設定保留（自動停止なし）'} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">unfollow監視</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Card label="送信対象友だち" value={data.unfollow.exposedFriends} />
          <Card label="24時間以内unfollow" value={data.unfollow.within24h} />
          <Card label="72時間以内unfollow" value={data.unfollow.within72h} />
          <Card label="サンプル数" value={data.unfollow.sampleSize} />
        </div>
        <p className="mt-2 text-xs text-gray-500">推定される時間的関連: {data.unfollow.interpretation}</p>
      </section>
      <MedicalSourceManager sources={sources} busy={sourceBusy} onCreate={createSource} onSetActive={setSourceActive} />
      <p className="text-xs text-gray-500">対象期間: {data.from} 〜 {data.to}。患者単位の情報は表示せず、すべて薬局アカウント内で集計しています。</p>
    </>}
  </main>
}
