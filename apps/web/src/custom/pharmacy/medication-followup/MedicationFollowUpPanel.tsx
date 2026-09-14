'use client'

import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../../../lib/api'
import type { PharmacyPatientHistory } from '../intake/api'
import {
  medicationFollowUpApi,
  type MedicationFollowUpAssignee,
  type MedicationFollowUpContact,
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

const CONTACT_CHANNEL_LABELS: Record<MedicationFollowUpContact['channel'], string> = {
  line: 'LINE',
  phone: '電話',
}
const CONTACT_OUTCOME_LABELS: Record<
  MedicationFollowUpContact['outcomeCode'], string
> = {
  answered: '応答あり',
  no_answer: '不通',
  resolved: '解決',
  follow_up_required: '再連絡が必要',
  escalated: 'エスカレーション',
}

const MEDICATION_FOLLOW_UP_TEMPLATE_PREVIEW =
  'お薬を使い始めてからの体調はいかがですか。あてはまるものを選んでください。'
const MEDICATION_FOLLOW_UP_CHOICES_PREVIEW = '問題なし / 気になることがある / 薬剤師に相談したい'

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

function contactDraft(
  channel: MedicationFollowUpContact['channel'],
  outcomeCode: MedicationFollowUpContact['outcomeCode'],
  nextContactLocal: string,
): MedicationFollowUpContact | null {
  const nextContactAt = outcomeCode === 'follow_up_required'
    ? toTokyoDueAt(nextContactLocal)
    : undefined
  if (outcomeCode === 'follow_up_required' && !nextContactAt) return null
  return {
    channel,
    outcomeCode,
    ...(nextContactAt ? { nextContactAt } : {}),
    idempotencyKey: crypto.randomUUID(),
  }
}

function needsMedicationFollowUpContact(status: MedicationFollowUpStatus): boolean {
  return status === 'concern' || status === 'pharmacist_requested' ||
    status === 'assigned' || status === 'escalated'
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

function medicationFollowUpDeadlineLabel(item: Pick<MedicationFollowUp, 'response_deadline_at'>): string | null {
  return item.response_deadline_at ? `一次返信期限 ${formatTokyo(item.response_deadline_at)}` : null
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
  const [responseDeadlineLocal, setResponseDeadlineLocal] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [assignees, setAssignees] = useState<MedicationFollowUpAssignee[]>([])
  const [assigneeStaffId, setAssigneeStaffId] = useState('')
  const [error, setError] = useState('')
  const [contactChannel, setContactChannel] = useState<MedicationFollowUpContact['channel']>('phone')
  const [contactOutcome, setContactOutcome] = useState<MedicationFollowUpContact['outcomeCode']>('answered')
  const [nextContactLocal, setNextContactLocal] = useState('')
  const dueAtPreview = toTokyoDueAt(dueLocal)
  const responseDeadlinePreview = dueAtPreview && responseDeadlineLocal
    ? toTokyoDueAt(responseDeadlineLocal, new Date(dueAtPreview).getTime())
    : null

  useEffect(() => {
    setSubmissionId((current) => candidates.some((item) => item.id === current)
      ? current
      : candidates[0]?.id ?? '')
  }, [candidates])

  useEffect(() => {
    let active = true
    void medicationFollowUpApi.listAssignees(accountId).then((response) => {
      if (active) setAssignees(response.assignees)
    }).catch(() => {
      if (active) setAssignees([])
    })
    return () => { active = false }
  }, [accountId])

  async function schedule() {
    const dueAt = toTokyoDueAt(dueLocal)
    if (!submissionId || !dueAt) {
      setError(submissionId
        ? '送信日時は現在より後の日時を選んでください。'
        : '対象の処方せんを選んでください。')
      return
    }
    const responseDeadlineAt = responseDeadlineLocal
      ? toTokyoDueAt(responseDeadlineLocal, new Date(dueAt).getTime())
      : null
    if (responseDeadlineLocal && !responseDeadlineAt) {
      setError('一次返信の期限は送信日時より後の日時を選んでください。')
      return
    }
    setScheduling(true)
    setError('')
    try {
      await medicationFollowUpApi.schedule(
        accountId, submissionId, dueAt, crypto.randomUUID(), responseDeadlineAt,
      )
      setDueLocal('')
      setResponseDeadlineLocal('')
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

  function readContactDraft(): MedicationFollowUpContact | null {
    const contact = contactDraft(contactChannel, contactOutcome, nextContactLocal)
    if (!contact) {
      setError(contactOutcome === 'follow_up_required'
        ? '再連絡が必要な場合は、現在より後の日時を入力してください。'
        : '対応記録の入力内容を確認してください。')
    }
    return contact
  }

  async function recordContact(followUp: MedicationFollowUp) {
    const contact = readContactDraft()
    if (!contact) return
    setBusyIds((current) => new Set(current).add(followUp.id))
    setError('')
    try {
      await medicationFollowUpApi.recordContact(
        accountId, followUp.id, contact, followUp.version,
      )
      await onChanged()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await onChanged().catch(() => undefined)
        setError('ほかのスタッフが先に更新しました。最新情報を読み込みました。')
      } else {
        setError('対応記録を保存できませんでした。')
      }
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(followUp.id)
        return next
      })
    }
  }

  async function transition(
    followUp: MedicationFollowUp & { contacts?: Array<{ outcome_code: MedicationFollowUpContact['outcomeCode'] }> },
    status: StaffTransition,
  ) {
    if (requiresMedicationFollowUpConfirmation(status)
      && !window.confirm(medicationFollowUpConfirmationMessage(status))) return
    const hasMeaningfulContact = followUp.contacts?.some((item) => item.outcome_code !== 'no_answer') ?? false
    if (status === 'responded' && contactOutcome === 'no_answer' && !hasMeaningfulContact) {
      setError('不通の記録だけでは対応済みにできません。応答内容を記録してください。')
      return
    }
    const contact = status === 'responded' && !hasMeaningfulContact ? readContactDraft() : undefined
    if (status === 'responded' && !contact) return
    if (status === 'assigned' && !assigneeStaffId) {
      setError('担当する人間スタッフを選択してください。')
      return
    }
    setBusyIds((current) => new Set(current).add(followUp.id))
    setError('')
    try {
      await medicationFollowUpApi.transition(
        accountId, followUp.id, status, followUp.version, contact ?? undefined,
        status === 'assigned' ? assigneeStaffId : undefined,
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
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
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
          <label className="grid gap-1">
            <span className="text-xs text-gray-600">一次返信の期限（任意）</span>
            <input type="datetime-local" min={dueLocal || minimumTokyoLocalValue()} value={responseDeadlineLocal} onChange={(event) => setResponseDeadlineLocal(event.target.value)} className="rounded border border-gray-300 px-3 py-2" />
          </label>
          <button type="button" onClick={() => void schedule()} disabled={scheduling || !submissionId || !dueAtPreview} className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">
            {scheduling ? '予約中…' : '予約する'}
          </button>
          {dueAtPreview && <div className="text-xs text-gray-600 sm:col-span-4">
            <p>{formatTokyo(dueAtPreview)} に、この患者へLINEで服薬後フォローを自動送信します。</p>
            <p className="mt-1">送信内容（固定文）: {MEDICATION_FOLLOW_UP_TEMPLATE_PREVIEW}</p>
            <p>選択肢: {MEDICATION_FOLLOW_UP_CHOICES_PREVIEW}</p>
            {responseDeadlinePreview && <p>一次返信の期限: {formatTokyo(responseDeadlinePreview)}</p>}
          </div>}
        </div>
      )}
      {history.medicationFollowUps.length === 0 ? (
        <p className="mt-3 text-gray-500">登録された服薬後フォローはありません。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {reviewItems.map((item) => {
            const attention = medicationFollowUpAttentionLabel(item.status)
            const needsContact = needsMedicationFollowUpContact(item.status)
            return <li key={item.id} className={`rounded p-3 ${attention ? 'border-l-4 border-amber-500 bg-amber-50/40' : 'bg-gray-50'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p>
                    <span className="font-medium">{STATUS_LABELS[item.status]}</span>
                    {attention && <span className="ml-2 rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">{attention}</span>}
                  </p>
                  <p className="mt-1 text-xs text-gray-600">{medicationFollowUpTimingLabel(item)}</p>
                  {medicationFollowUpDeadlineLabel(item) && <p className="mt-1 text-xs text-gray-600">{medicationFollowUpDeadlineLabel(item)}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {medicationFollowUpActions(item.status).includes('assigned') && <label className="grid min-w-40 gap-1">
                    <span className="text-xs text-gray-600">担当者</span>
                    <select aria-label="担当者" value={assigneeStaffId} onChange={(event) => setAssigneeStaffId(event.target.value)} className="min-h-[44px] rounded border border-gray-300 bg-white px-2 py-2 text-xs">
                      <option value="">担当者を選択</option>
                      {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}</option>)}
                    </select>
                  </label>}
                  {medicationFollowUpActions(item.status).map((action) => (
                    <button key={action} type="button" disabled={busyIds.has(item.id)} onClick={() => void transition(item, action)} className="min-h-[44px] rounded border border-gray-300 bg-white px-3 py-2 text-xs disabled:opacity-50">
                      {busyIds.has(item.id) ? '更新中…' : ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              </div>
              {needsContact && <div className="mt-3 grid gap-2 border-t border-gray-200 pt-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
                <label className="grid gap-1">
                  <span className="text-xs text-gray-600">対応手段</span>
                  <select aria-label="対応手段" value={contactChannel} onChange={(event) => setContactChannel(event.target.value as MedicationFollowUpContact['channel'])} className="rounded border border-gray-300 px-2 py-2 text-sm">
                    {Object.entries(CONTACT_CHANNEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-xs text-gray-600">対応結果</span>
                  <select aria-label="対応結果" value={contactOutcome} onChange={(event) => setContactOutcome(event.target.value as MedicationFollowUpContact['outcomeCode'])} className="rounded border border-gray-300 px-2 py-2 text-sm">
                    {Object.entries(CONTACT_OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                {contactOutcome === 'follow_up_required' ? <label className="grid gap-1">
                  <span className="text-xs text-gray-600">再連絡日時（日本時間）</span>
                  <input aria-label="再連絡日時" type="datetime-local" min={minimumTokyoLocalValue()} value={nextContactLocal} onChange={(event) => setNextContactLocal(event.target.value)} className="rounded border border-gray-300 px-2 py-2 text-sm" />
                </label> : <span />}
                <button type="button" disabled={busyIds.has(item.id)} onClick={() => void recordContact(item)} className="min-h-[44px] rounded border border-gray-300 bg-white px-3 py-2 text-xs disabled:opacity-50">
                  対応記録を保存
                </button>
              </div>}
              {item.contacts.length > 0 && <ul className="mt-3 space-y-1 border-t border-gray-200 pt-2 text-xs text-gray-600">
                {item.contacts.map((contact) => <li key={contact.id}>
                  {CONTACT_CHANNEL_LABELS[contact.channel]} / {CONTACT_OUTCOME_LABELS[contact.outcome_code]} / {formatTokyo(contact.occurred_at)}
                  {contact.next_contact_at && ` / 再連絡 ${formatTokyo(contact.next_contact_at)}`}
                </li>)}
              </ul>}
            </li>
          })}
        </ul>
      )}
    </section>
  )
}
