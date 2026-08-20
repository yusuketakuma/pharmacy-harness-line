'use client'

import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../../../lib/api'
import type { PharmacyPatientHistory } from '../intake/api'
import {
  medicationFollowUpApi,
  type MedicationFollowUp,
  type MedicationFollowUpStatus,
} from './api'

export type StaffTransition = 'assigned' | 'responded' | 'escalated' | 'closed' | 'cancelled'

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
  cancelled: '送信取りやめ',
}

const ACTION_LABELS: Record<StaffTransition, string> = {
  assigned: '担当する',
  responded: '対応済みにする',
  escalated: '優先確認にする',
  closed: '完了にする',
  cancelled: 'フォローを取り消す',
}

export function requiresMedicationFollowUpConfirmation(status: StaffTransition): boolean {
  return status === 'closed' || status === 'cancelled'
}

export function medicationFollowUpConfirmationMessage(status: StaffTransition): string {
  return `「${ACTION_LABELS[status]}」を実行します。この操作は取り消せません。よろしいですか？`
}

export function minimumTokyoLocalValue(now = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000 + 60 * 1000).toISOString().slice(0, 16)
}

export function toTokyoDueAt(value: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const date = new Date(`${value}:00+09:00`)
  return Number.isFinite(date.getTime()) && date.getTime() > now ? date.toISOString() : null
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
      return ['assigned', 'escalated']
    case 'assigned':
      return ['responded', 'escalated']
    case 'escalated':
      return ['responded']
    case 'responded':
      return ['closed']
    default:
      return []
  }
}

export function medicationFollowUpAttentionLabel(status: MedicationFollowUpStatus): string | null {
  switch (status) {
    case 'pharmacist_requested': return '相談希望・要対応'
    case 'concern': return '気になること・要対応'
    case 'escalated': return '優先確認・要対応'
    case 'assigned': return '担当中'
    default: return null
  }
}

const REVIEW_PRIORITY: Partial<Record<MedicationFollowUpStatus, number>> = {
  pharmacist_requested: 0,
  escalated: 0,
  concern: 1,
  assigned: 2,
  delivered: 3,
}

export function sortMedicationFollowUpsForReview<
  T extends Pick<MedicationFollowUp, 'status' | 'due_at' | 'responded_at'>,
>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    (REVIEW_PRIORITY[left.status] ?? 4) - (REVIEW_PRIORITY[right.status] ?? 4) ||
    new Date(left.responded_at ?? left.due_at).getTime() -
      new Date(right.responded_at ?? right.due_at).getTime())
}

function formatTokyo(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
    }).format(date)
    : value
}

export function prescriptionFollowUpOptionLabel(item: {
  id: string
  active_revision: number | null
  closed_at: string | null
  created_at: string
}): string {
  const revision = item.active_revision ? `第${item.active_revision}版 / ` : ''
  return `処方せん ${item.id.slice(-6)} / ${revision}お渡し ${formatTokyo(item.closed_at ?? item.created_at)}`
}

export function medicationFollowUpTimingLabel(item: Pick<
  MedicationFollowUp,
  'status' | 'due_at' | 'delivered_at' | 'responded_at' | 'closed_at' | 'updated_at'
>): string {
  if (item.status === 'scheduled' || item.status === 'due') {
    return `送信予定 ${formatTokyo(item.due_at)}`
  }
  if (item.status === 'delivered') {
    return `送信済み ${formatTokyo(item.delivered_at ?? item.due_at)}`
  }
  if (item.status === 'closed' || item.status === 'cancelled') {
    return `終了 ${formatTokyo(item.closed_at ?? item.updated_at)}`
  }
  return `患者回答 ${formatTokyo(item.responded_at ?? item.delivered_at ?? item.due_at)}`
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
  const reviewItems = useMemo(
    () => sortMedicationFollowUpsForReview(history.medicationFollowUps),
    [history.medicationFollowUps],
  )
  const attentionCount = reviewItems.filter((item) =>
    medicationFollowUpAttentionLabel(item.status)?.includes('要対応')).length
  const [submissionId, setSubmissionId] = useState('')
  const [dueLocal, setDueLocal] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const dueAtPreview = toTokyoDueAt(dueLocal)

  useEffect(() => {
    setSubmissionId((current) => candidates.some((item) => item.id === current)
      ? current
      : candidates[0]?.id ?? '')
  }, [candidates])

  async function schedule() {
    const dueAt = toTokyoDueAt(dueLocal)
    if (!submissionId || !dueAt) {
      setError(submissionId
        ? '送信日時は現在より後の日時を選んでください。'
        : '対象の処方せんを選んでください。')
      return
    }
    setScheduling(true)
    setError('')
    try {
      await medicationFollowUpApi.schedule(
        accountId, submissionId, dueAt, crypto.randomUUID(),
      )
      setDueLocal('')
      try {
        await onChanged()
      } catch {
        setError('予約は登録済みですが、最新情報を再取得できませんでした。画面を再読み込みしてください。')
      }
    } catch {
      setError('予約を登録できませんでした。再度お試しください。')
    } finally {
      setScheduling(false)
    }
  }

  async function transition(followUp: MedicationFollowUp, status: StaffTransition) {
    if (requiresMedicationFollowUpConfirmation(status)
      && !window.confirm(medicationFollowUpConfirmationMessage(status))) return
    setBusyIds((current) => new Set(current).add(followUp.id))
    setError('')
    try {
      await medicationFollowUpApi.transition(
        accountId, followUp.id, status, followUp.version,
      )
      try {
        await onChanged()
      } catch {
        setError('更新は保存済みですが、最新情報を再取得できませんでした。画面を再読み込みしてください。')
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await onChanged().catch(() => undefined)
        setError('ほかのスタッフが先に状態を更新しました。最新情報を読み込みました。内容を確認してもう一度操作してください。')
      } else {
        setError('状態を更新できませんでした。再度お試しください。')
      }
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(followUp.id)
        return next
      })
    }
  }

  return (
    <section aria-labelledby="medication-followup-title" className="rounded-lg border border-gray-200 p-4">
      <h3 id="medication-followup-title" className="font-semibold">服薬後フォロー</h3>
      <p className="mt-1 text-xs text-gray-500">
        薬剤師が対象と送信日時を決めます。薬の名前や処方内容は自動通知に載せません。
        予約前に患者へ目的・連絡手段・予定時刻を説明し、了承を確認してください。
      </p>
      {attentionCount > 0 && (
        <p role="status" className="mt-3 rounded bg-amber-50 p-2 text-sm font-bold text-amber-900">
          要対応 {attentionCount}件 — 患者回答を確認し、担当・対応済みの順に記録してから完了してください。
        </p>
      )}
      {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-red-700">{error}</p>}
      {candidates.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-xs text-gray-600">お渡し済みの処方せん</span>
            <select value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} className="rounded border border-gray-300 px-3 py-2">
              {candidates.map((item) => <option key={item.id} value={item.id}>{prescriptionFollowUpOptionLabel(item)}</option>)}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-gray-600">送信日時（日本時間）</span>
            <input type="datetime-local" min={minimumTokyoLocalValue()} value={dueLocal} onChange={(event) => setDueLocal(event.target.value)} className="rounded border border-gray-300 px-3 py-2" />
          </label>
          <button type="button" onClick={() => void schedule()} disabled={scheduling || !submissionId || !dueAtPreview} className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">
            {scheduling ? '予約中…' : '予約する'}
          </button>
          {dueAtPreview && <p className="text-xs text-gray-600 sm:col-span-3">{formatTokyo(dueAtPreview)} に、この患者へLINEで服薬後フォローを自動送信します。</p>}
        </div>
      )}
      {history.medicationFollowUps.length === 0 ? (
        <p className="mt-3 text-gray-500">登録された服薬後フォローはありません。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {reviewItems.map((item) => {
            const attention = medicationFollowUpAttentionLabel(item.status)
            return <li key={item.id} className={`rounded p-3 ${attention ? 'border-l-4 border-amber-500 bg-amber-50/40' : 'bg-gray-50'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p>
                    <span className="font-medium">{STATUS_LABELS[item.status]}</span>
                    {attention && <span className="ml-2 rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">{attention}</span>}
                  </p>
                  <p className="mt-1 text-xs text-gray-600">{medicationFollowUpTimingLabel(item)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {medicationFollowUpActions(item.status).map((action) => (
                    <button key={action} type="button" disabled={busyIds.has(item.id)} onClick={() => void transition(item, action)} className="min-h-[44px] rounded border border-gray-300 bg-white px-3 py-2 text-xs disabled:opacity-50">
                      {busyIds.has(item.id) ? '更新中…' : ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          })}
        </ul>
      )}
    </section>
  )
}
