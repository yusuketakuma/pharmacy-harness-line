'use client'

import React, { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAccount } from '../../../contexts/account-context'
import {
  continuityAdminApi,
  type ContinuityObligation,
  type NextIntakeExpectation,
  type NextIntakeOffer,
} from './api'

const STATUS_LABELS: Record<ContinuityObligation['status'], string> = {
  active: '次回フォロー待ち',
  linked: '次の処方せんと紐付け済み',
  fulfilled: '完了',
  paused: '一時停止',
  ended: '終了',
}

const EXPECTATION_LABELS: Record<NextIntakeExpectation['status'], string> = {
  offered: '患者の回答待ち',
  accepted: 'お知らせ登録済み',
  active: '送信処理中',
  reminded: 'お知らせ済み',
  linked: '次の処方せんと紐付け済み',
  fulfilled: '完了',
  paused: '一時停止',
  ended: '登録しない',
}

export function tokyoLocalToIso(value: string): string {
  const date = new Date(`${value}:00+09:00`)
  if (Number.isNaN(date.valueOf())) throw new Error('invalid reminder time')
  return date.toISOString()
}

export function NextIntakeOfferForm({
  obligationId,
  busy,
  onOffer,
}: {
  obligationId: string
  busy: boolean
  onOffer: (obligationId: string, offer: NextIntakeOffer) => Promise<void>
}) {
  const [mode, setMode] = useState<NextIntakeOffer['timingSource']>('manual_supply_days')
  const [supplyDays, setSupplyDays] = useState('')
  const [expectedFrom, setExpectedFrom] = useState('')
  const [expectedTo, setExpectedTo] = useState('')
  const [reminderAt, setReminderAt] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const offer: NextIntakeOffer = mode === 'manual_supply_days'
      ? { timingSource: mode, supplyDays: Number(supplyDays) }
      : {
        timingSource: mode,
        expectedFrom,
        expectedTo,
        reminderAt: tokyoLocalToIso(reminderAt),
      }
    void onOffer(obligationId, offer)
  }

  return <form onSubmit={submit} className="space-y-3 rounded-lg border border-green-100 bg-green-50 p-3">
    <div>
      <p className="font-medium text-gray-900">次回事前送信のお知らせ</p>
      <p className="mt-1 text-xs text-gray-600">薬剤師が時期を確認して登録します。薬の確保や調剤を約束する登録ではありません。</p>
    </div>
    <label className="block text-sm">入力方法
      <select value={mode} onChange={(event) => setMode(event.target.value as NextIntakeOffer['timingSource'])} className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
        <option value="manual_supply_days">服用日数を手入力</option>
        <option value="manual_window">予定期間を手入力</option>
      </select>
    </label>
    <label className="block text-sm">服用日数
      <input type="number" min="1" max="365" value={supplyDays} onChange={(event) => setSupplyDays(event.target.value)} disabled={mode !== 'manual_supply_days'} required={mode === 'manual_supply_days'} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100" />
    </label>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-sm">予定期間（開始）
        <input type="date" value={expectedFrom} onChange={(event) => setExpectedFrom(event.target.value)} disabled={mode !== 'manual_window'} required={mode === 'manual_window'} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100" />
      </label>
      <label className="text-sm">予定期間（終了）
        <input type="date" value={expectedTo} onChange={(event) => setExpectedTo(event.target.value)} disabled={mode !== 'manual_window'} required={mode === 'manual_window'} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100" />
      </label>
    </div>
    <label className="block text-sm">お知らせ日時
      <input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} disabled={mode !== 'manual_window'} required={mode === 'manual_window'} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100" />
    </label>
    <button type="submit" disabled={busy} className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">患者へ確認を表示</button>
  </form>
}

function ExpectationSummary({ expectation }: { expectation: NextIntakeExpectation }) {
  return <div>
    <p className="font-medium">{EXPECTATION_LABELS[expectation.status]}</p>
    <p className="mt-1 text-xs text-gray-600">{expectation.expected_from}〜{expectation.expected_to}</p>
  </div>
}

export default function ContinuityAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<ContinuityObligation[]>([])
  const [expectations, setExpectations] = useState<NextIntakeExpectation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true)
    setError('')
    try {
      const result = await continuityAdminApi.list(selectedAccountId)
      setItems(result.obligations)
      setExpectations(result.expectations)
    } catch {
      setError('継続フォロー一覧を取得できませんでした。')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => items.reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1
    return result
  }, {}), [items])
  const expectationByObligation = new Map(expectations.map((item) => [item.obligation_id, item]))

  const offer = async (obligationId: string, input: NextIntakeOffer) => {
    if (!selectedAccountId) return
    setLoading(true)
    setError('')
    try {
      await continuityAdminApi.offer(selectedAccountId, obligationId, input)
      await load()
    } catch {
      setError('次回事前送信のお知らせを登録できませんでした。')
      setLoading(false)
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return <div className="mx-auto max-w-7xl space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-gray-900">継続フォロー</h1><p className="mt-1 text-sm text-gray-500">調剤完了後の次回事前送信のお知らせを管理します。</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">次回フォロー待ち</p><p className="mt-1 text-2xl font-bold">{counts.active ?? 0}件</p></div>
      <div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">紐付け済み</p><p className="mt-1 text-2xl font-bold">{counts.linked ?? 0}件</p></div>
      <div className="rounded-xl border border-gray-200 bg-white p-4"><p className="text-sm text-gray-500">一時停止</p><p className="mt-1 text-2xl font-bold">{counts.paused ?? 0}件</p></div>
    </div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {items.length === 0 && !loading
      ? <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">継続フォローはありません。</div>
      : <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white"><table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="px-4 py-3">状態</th><th className="px-4 py-3">次回のお知らせ</th></tr></thead><tbody className="divide-y divide-gray-200">{items.map((item) => {
        const expectation = expectationByObligation.get(item.id)
        return <tr key={item.id}><td className="px-4 py-3 font-medium">{STATUS_LABELS[item.status]}</td><td className="min-w-80 px-4 py-3">{expectation
          ? <ExpectationSummary expectation={expectation} />
          : item.status === 'active'
            ? <NextIntakeOfferForm obligationId={item.id} busy={loading} onOffer={offer} />
            : <span className="text-gray-500">未設定</span>}</td></tr>
      })}</tbody></table></div>}
  </div>
}
