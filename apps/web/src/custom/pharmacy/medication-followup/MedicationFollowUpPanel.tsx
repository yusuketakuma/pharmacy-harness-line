'use client'

import { useEffect, useMemo, useState } from 'react'
import type { PharmacyPatientHistory } from '../intake/api'
import {
  medicationFollowUpApi,
  type MedicationFollowUp,
  type MedicationFollowUpStatus,
} from './api'

type StaffTransition = 'assigned' | 'responded' | 'escalated' | 'closed' | 'cancelled'

const STATUS_LABELS: Record<MedicationFollowUpStatus, string> = {
  scheduled: '送信予約',
  due: '送信処理中',
  delivered: '回答待ち',
  no_issue: '問題なし',
  concern: '気になることあり',
  pharmacist_requested: '薬剤師への相談希望',
  assigned: '担当中',
  responded: '対応済み',
  escalated: '優先確認',
  closed: '完了',
  cancelled: 'キャンセル',
}

const ACTION_LABELS: Record<StaffTransition, string> = {
  assigned: '担当する',
  responded: '対応済みにする',
  escalated: '優先確認にする',
  closed: '完了にする',
  cancelled: 'キャンセル',
}

export function toTokyoDueAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const date = new Date(`${value}:00+09:00`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function eligibleMedicationFollowUpSubmissions<
  T extends { id: string; status: string },
>(prescriptions: T[], followUps: Array<Pick<MedicationFollowUp, 'source_submission_id'>>): T[] {
  const used = new Set(followUps.map((item) => item.source_submission_id))
  return prescriptions.filter((item) => item.status === 'closed' && !used.has(item.id))
}

export function medicationFollowUpActions(status: MedicationFollowUpStatus): StaffTransition[] {
  switch (status) {
    case 'scheduled':
    case 'due':
    case 'delivered':
      return ['cancelled']
    case 'no_issue':
      return ['closed']
    case 'concern':
    case 'pharmacist_requested':
      return ['assigned', 'escalated', 'closed']
    case 'assigned':
      return ['responded', 'escalated', 'closed']
    case 'responded':
    case 'escalated':
      return ['closed']
    default:
      return []
  }
}

function formatTokyo(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
    }).format(date)
    : value
}

export function MedicationFollowUpPanel({
  accountId,
  history,
  onChanged,
}: {
  accountId: string
  history: Pick<PharmacyPatientHistory, 'prescriptions' | 'medicationFollowUps'>
  onChanged: () => Promise<void>
}) {
  const candidates = useMemo(() => eligibleMedicationFollowUpSubmissions(
    history.prescriptions, history.medicationFollowUps,
  ), [history])
  const [submissionId, setSubmissionId] = useState('')
  const [dueLocal, setDueLocal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSubmissionId((current) => candidates.some((item) => item.id === current)
      ? current
      : candidates[0]?.id ?? '')
  }, [candidates])

  async function schedule() {
    const dueAt = toTokyoDueAt(dueLocal)
    if (!submissionId || !dueAt) {
      setError('対象の処方せんと送信日時を選んでください。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await medicationFollowUpApi.schedule(
        accountId, submissionId, dueAt, crypto.randomUUID(),
      )
      setDueLocal('')
      await onChanged()
    } catch {
      setError('登録結果を確認できませんでした。画面を再読み込みして確認してください。')
    } finally {
      setBusy(false)
    }
  }

  async function transition(followUp: MedicationFollowUp, status: StaffTransition) {
    setBusy(true)
    setError('')
    try {
      await medicationFollowUpApi.transition(
        accountId, followUp.id, status, followUp.version,
      )
      await onChanged()
    } catch {
      setError('更新結果を確認できませんでした。画面を再読み込みして確認してください。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="medication-followup-title" className="rounded-lg border border-gray-200 p-4">
      <h3 id="medication-followup-title" className="font-semibold">服薬後フォロー</h3>
      <p className="mt-1 text-xs text-gray-500">
        薬剤師が対象と送信日時を決めます。薬の名前や処方内容は自動通知に載せません。
      </p>
      {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-red-700">{error}</p>}
      {candidates.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-xs text-gray-600">お渡し済みの処方せん</span>
            <select value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} className="rounded border border-gray-300 px-3 py-2">
              {candidates.map((item) => <option key={item.id} value={item.id}>{formatTokyo(item.closed_at ?? item.created_at)}</option>)}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-gray-600">送信日時（日本時間）</span>
            <input type="datetime-local" value={dueLocal} onChange={(event) => setDueLocal(event.target.value)} className="rounded border border-gray-300 px-3 py-2" />
          </label>
          <button type="button" onClick={() => void schedule()} disabled={busy || !submissionId || !dueLocal} className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">
            予約する
          </button>
        </div>
      )}
      {history.medicationFollowUps.length === 0 ? (
        <p className="mt-3 text-gray-500">登録された服薬後フォローはありません。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {history.medicationFollowUps.map((item) => (
            <li key={item.id} className="rounded bg-gray-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p><span className="font-medium">{STATUS_LABELS[item.status]}</span><span className="ml-2 text-xs text-gray-500">送信予定 {formatTokyo(item.due_at)}</span></p>
                <div className="flex flex-wrap gap-2">
                  {medicationFollowUpActions(item.status).map((action) => (
                    <button key={action} type="button" disabled={busy} onClick={() => void transition(item, action)} className="rounded border border-gray-300 bg-white px-3 py-1 text-xs disabled:opacity-50">
                      {ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
