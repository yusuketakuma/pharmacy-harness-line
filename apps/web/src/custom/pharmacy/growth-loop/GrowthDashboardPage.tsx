'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'

type Dashboard = Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.dashboard>>, { success: true }>['data']

function Card({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><p className="text-sm text-gray-500">{label}</p><p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>{note && <p className="mt-1 text-xs text-gray-500">{note}</p>}</div>
}

function rate(numerator: number, denominator: number): string {
  return denominator ? `${Math.round((numerator / denominator) * 100)}%` : '—'
}

export default function GrowthDashboardPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true); setError('')
    try {
      const response = await api.pharmacyGrowth.dashboard(selectedAccountId)
      if (!response.success) throw new Error(response.error)
      setData(response.data as Dashboard)
    } catch {
      setError('薬局Growth Loopの集計を取得できませんでした。薬局モードと権限を確認してください。')
    } finally { setLoading(false) }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>
  if (loading && !data) return <p className="py-10 text-center text-gray-500">集計を読み込み中...</p>
  return <main className="mx-auto max-w-7xl space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-gray-900">薬局 Growth Loop</h1><p className="mt-1 text-sm text-gray-500">受付入口、約束時刻、期限確認を薬局単位で確認します。</p></div><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button></div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {data && <>
      <section><h2 className="mb-2 text-sm font-semibold text-gray-700">入口</h2><div className="grid gap-3 sm:grid-cols-3"><Card label="初回友だち追加" value={data.entry.firstTimeFollows} /><Card label="初回送信率" value={rate(data.entry.firstSubmissionRate.numerator, data.entry.firstSubmissionRate.denominator)} note={`${data.entry.firstSubmissionRate.numerator}/${data.entry.firstSubmissionRate.denominator}（成熟cohort）`} /><Card label="2回目送信率" value={rate(data.entry.secondSubmissionRate.numerator, data.entry.secondSubmissionRate.denominator)} note={`${data.entry.secondSubmissionRate.numerator}/${data.entry.secondSubmissionRate.denominator}（成熟cohort）`} /></div></section>
      <section><h2 className="mb-2 text-sm font-semibold text-gray-700">発行元</h2><div className="grid gap-3 sm:grid-cols-4"><Card label="primary" value={data.sources.primary} /><Card label="other" value={data.sources.other} note={`構成比 ${data.sources.otherShare === null ? '—' : `${Math.round(data.sources.otherShare * 100)}%`}`} /><Card label="unknown" value={data.sources.unknown} note="不足データ" /><Card label="分類済み分母" value={data.sources.knownDenominator} /></div></section>
      <section><h2 className="mb-2 text-sm font-semibold text-gray-700">約束と期限</h2><div className="grid gap-3 sm:grid-cols-4"><Card label="予定あり" value={data.promises.promised} /><Card label="予定内率" value={data.promises.onTimeRate === null ? '—' : `${Math.round(data.promises.onTimeRate * 100)}%`} /><Card label="p50遅延（分）" value={data.promises.p50LatenessMinutes === null ? '—' : Math.round(data.promises.p50LatenessMinutes)} /><Card label="p90遅延（分）" value={data.promises.p90LatenessMinutes === null ? '—' : Math.round(data.promises.p90LatenessMinutes)} /></div><p className="mt-2 text-xs text-gray-500">期限確認待ち: {data.validity.expiredReviewRequired}件 / リマインド後期限内完了: {data.validity.reminderClosedInTime}件</p></section>
      <section><h2 className="mb-2 text-sm font-semibold text-gray-700">通知とunfollow</h2><div className="grid gap-3 sm:grid-cols-3"><Card label="送信対象友だち" value={data.unfollow.exposedFriends} /><Card label="24時間以内unfollow" value={data.unfollow.within24h} /><Card label="72時間以内unfollow" value={data.unfollow.within72h} /></div><p className="mt-2 text-xs text-gray-500">{data.unfollow.interpretation}</p></section>
      <p className="text-xs text-gray-500">対象期間: {data.from} 〜 {data.to}。患者単位の情報は表示せず、すべて薬局アカウント内で集計しています。</p>
    </>}
  </main>
}
