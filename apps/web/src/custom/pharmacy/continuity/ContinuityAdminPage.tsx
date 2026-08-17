'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { continuityAdminApi, type ContinuityObligation } from './api'

const STATUS_LABELS: Record<ContinuityObligation['status'], string> = {
  active: '次回フォロー待ち', linked: '次の処方せんと紐付け済み', fulfilled: '完了', paused: '一時停止', ended: '終了',
}

export default function ContinuityAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<ContinuityObligation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true); setError('')
    try { setItems((await continuityAdminApi.list(selectedAccountId)).obligations) } catch { setError('継続フォロー一覧を取得できませんでした。') } finally { setLoading(false) }
  }, [selectedAccountId])
  useEffect(() => { void load() }, [load])
  const counts = useMemo(() => items.reduce<Record<string, number>>((result, item) => { result[item.status] = (result[item.status] ?? 0) + 1; return result }, {}), [items])
  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>
  return <div className="mx-auto max-w-7xl space-y-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-gray-900">継続フォロー</h1><p className="mt-1 text-sm text-gray-500">調剤完了後の次回相談時期と受付状況を確認します。</p></div><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">次回フォロー待ち</p><p className="mt-1 text-2xl font-bold">{counts.active ?? 0}件</p></div><div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">紐付け済み</p><p className="mt-1 text-2xl font-bold">{counts.linked ?? 0}件</p></div><div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">一時停止</p><p className="mt-1 text-2xl font-bold">{counts.paused ?? 0}件</p></div></div>{error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}{items.length === 0 && !loading ? <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">継続フォローはありません。</div> : <div className="overflow-hidden rounded-xl border border-gray-200 bg-white"><table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="px-4 py-3">状態</th><th className="px-4 py-3">次回の目安</th><th className="px-4 py-3">リマインド</th></tr></thead><tbody className="divide-y divide-gray-200">{items.map((item) => <tr key={item.id}><td className="px-4 py-3 font-medium">{STATUS_LABELS[item.status]}</td><td className="px-4 py-3">{item.expected_next_from}〜{item.expected_next_to}</td><td className="px-4 py-3">{item.reminder_count}回</td></tr>)}</tbody></table></div>}</div>
}
