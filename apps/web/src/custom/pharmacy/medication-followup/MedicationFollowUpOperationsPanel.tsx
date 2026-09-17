'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import {
  medicationFollowUpApi,
  type FollowUpOperationsMessageCode,
  type MedicationFollowUpAssignee,
  type MedicationFollowUpOperations,
} from './api'

export type OperationsDraft = {
  serviceHoursText: string
  typicalMinutes: string
  concernMinutes: string
  pharmacistRequestedMinutes: string
  assignedMinutes: string
  escalatedMinutes: string
  respondedMinutes: string
  primaryStaffId: string
  backupStaffId: string
  afterHoursMessageCode: FollowUpOperationsMessageCode
  emergencyMessageCode: FollowUpOperationsMessageCode
  enabled: boolean
}

const MESSAGE_CODE_LABELS: Record<FollowUpOperationsMessageCode, string> = {
  contact_pharmacy_during_hours: '営業時間内への誘導',
  seek_urgent_care: '早急な受診の案内',
}

export function operationsMessageCodeLabel(code: FollowUpOperationsMessageCode): string {
  return MESSAGE_CODE_LABELS[code]
}

// Patient-facing fixed line for each code. Mirrors the LIFF wording in
// followUpOperationsOutlookLines so staff can preview the exact text.
export function operationsMessageCodePatientLine(code: FollowUpOperationsMessageCode): string {
  return code === 'seek_urgent_care'
    ? 'お急ぎの症状がある場合は、返信を待たずに最寄りの医療機関へご相談ください。'
    : '営業時間外のご連絡は、次の営業時間に順次ご対応します。'
}

const EMPTY_DRAFT: OperationsDraft = {
  serviceHoursText: '',
  typicalMinutes: '',
  concernMinutes: '',
  pharmacistRequestedMinutes: '',
  assignedMinutes: '',
  escalatedMinutes: '',
  respondedMinutes: '',
  primaryStaffId: '',
  backupStaffId: '',
  afterHoursMessageCode: 'contact_pharmacy_during_hours',
  emergencyMessageCode: 'seek_urgent_care',
  enabled: false,
}

export function operationsDraftFrom(operations: MedicationFollowUpOperations | null): OperationsDraft {
  if (!operations) return { ...EMPTY_DRAFT }
  const sla = operations.response_sla
  const minute = (key: string) => typeof sla[key] === 'number' ? String(sla[key]) : ''
  return {
    serviceHoursText: operations.service_hours_text,
    typicalMinutes: minute('typical_minutes'),
    concernMinutes: minute('concern_minutes'),
    pharmacistRequestedMinutes: minute('pharmacist_requested_minutes'),
    assignedMinutes: minute('assigned_minutes'),
    escalatedMinutes: minute('escalated_minutes'),
    respondedMinutes: minute('responded_minutes'),
    primaryStaffId: operations.primary_staff_id,
    backupStaffId: operations.backup_staff_id ?? '',
    afterHoursMessageCode: operations.after_hours_message_code,
    emergencyMessageCode: operations.emergency_message_code,
    enabled: operations.enabled,
  }
}

function minuteField(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10080 ? parsed : null
}

export function buildOperationsSla(draft: OperationsDraft): Record<string, number> | null {
  const entries: Array<[string, string]> = [
    ['typical_minutes', draft.typicalMinutes],
    ['concern_minutes', draft.concernMinutes],
    ['pharmacist_requested_minutes', draft.pharmacistRequestedMinutes],
    ['assigned_minutes', draft.assignedMinutes],
    ['escalated_minutes', draft.escalatedMinutes],
    ['responded_minutes', draft.respondedMinutes],
  ]
  const sla: Record<string, number> = {}
  for (const [key, value] of entries) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const parsed = minuteField(trimmed)
    if (parsed === null) return null
    sla[key] = parsed
  }
  return sla
}

export function operationsDraftError(draft: OperationsDraft): string | null {
  const hours = draft.serviceHoursText.trim()
  if (hours.length < 1 || hours.length > 2048) return '対応時間を入力してください（2048文字以内）。'
  if (buildOperationsSla(draft) === null) return '返信目安は1〜10080の整数（分）で入力してください。'
  if (!draft.primaryStaffId) return '主担当を選んでください。'
  if (draft.backupStaffId && draft.backupStaffId === draft.primaryStaffId) {
    return '主担当と副担当に同じスタッフは選べません。'
  }
  if (draft.enabled && minuteField(draft.typicalMinutes) === null) {
    return '有効にするには「通常の返信目安（分）」を入力してください。患者画面に表示されます。'
  }
  return null
}

export function operationsDraftChanged(
  draft: OperationsDraft, operations: MedicationFollowUpOperations | null,
): boolean {
  return JSON.stringify(draft) !== JSON.stringify(operationsDraftFrom(operations))
}

export default function MedicationFollowUpOperationsPanel({
  accountId,
  canMutate,
}: {
  accountId: string
  canMutate: boolean
}) {
  const [operations, setOperations] = useState<MedicationFollowUpOperations | null>(null)
  const [assignees, setAssignees] = useState<MedicationFollowUpAssignee[]>([])
  const [draft, setDraft] = useState<OperationsDraft>({ ...EMPTY_DRAFT })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const accountRef = useRef(accountId)
  accountRef.current = accountId

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [operationsResponse, assigneesResponse] = await Promise.all([
        medicationFollowUpApi.getOperations(accountId),
        medicationFollowUpApi.listAssignees(accountId),
      ])
      if (accountRef.current !== accountId) return
      setOperations(operationsResponse.operations)
      setDraft(operationsDraftFrom(operationsResponse.operations))
      setAssignees(assigneesResponse.assignees)
      setUnavailable(false)
    } catch (cause) {
      if (accountRef.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 503) {
        setUnavailable(true)
      } else {
        setError('運用設定を取得できませんでした。再読み込みしてください。')
      }
    } finally {
      if (accountRef.current === accountId) setLoading(false)
    }
  }, [accountId])

  useEffect(() => { void load() }, [load])

  const validationError = operationsDraftError(draft)
  const dirty = useMemo(() => operationsDraftChanged(draft, operations), [draft, operations])
  const enabling = draft.enabled && operations?.enabled !== true

  async function save() {
    if (!canMutate) {
      setError('一般スタッフは閲覧のみです。変更はオーナーまたは管理者が行ってください。')
      return
    }
    if (saving || validationError || !dirty) return
    const sla = buildOperationsSla(draft)
    if (sla === null) return
    if (enabling && !window.confirm(
      '有効にすると、患者画面に「対応の見通し」が表示されます。内容を確認して保存しますか？',
    )) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await medicationFollowUpApi.saveOperations(accountId, {
        serviceHoursText: draft.serviceHoursText.trim(),
        responseSla: sla,
        primaryStaffId: draft.primaryStaffId,
        backupStaffId: draft.backupStaffId || null,
        afterHoursMessageCode: draft.afterHoursMessageCode,
        emergencyMessageCode: draft.emergencyMessageCode,
        enabled: draft.enabled,
        expectedVersion: operations?.version ?? 0,
      })
      if (accountRef.current !== accountId) return
      setOperations(response.operations)
      setDraft(operationsDraftFrom(response.operations))
      setMessage('運用設定を保存しました。')
    } catch (cause) {
      if (accountRef.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        setError('別の更新がありました。最新の設定を再取得しました。')
        await load()
      } else {
        setError('運用設定を保存できませんでした。入力内容と担当者の割当を確認してください。')
      }
    } finally {
      if (accountRef.current === accountId) setSaving(false)
    }
  }

  if (unavailable) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="followup-operations-title">
        <h2 id="followup-operations-title" className="font-semibold">服薬フォローの運用設定</h2>
        <p className="mt-2 text-sm text-gray-600">この環境では運用設定をまだ利用できません。機能の準備が整うまでお待ちください。</p>
      </section>
    )
  }

  const set = (patch: Partial<OperationsDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const minuteInput = (
    key: keyof Pick<OperationsDraft, 'typicalMinutes' | 'concernMinutes' |
      'pharmacistRequestedMinutes' | 'assignedMinutes' | 'escalatedMinutes' | 'respondedMinutes'>,
    label: string, required = false,
  ) => (
    <label className="block text-sm font-medium">
      {label}{required && <span className="text-red-700">（必須）</span>}
      <input type="number" min={1} max={10080} step={1} value={draft[key]}
        onChange={(event) => set({ [key]: event.target.value })}
        disabled={saving || !canMutate}
        className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" />
    </label>
  )

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="followup-operations-title">
      <h2 id="followup-operations-title" className="font-semibold">服薬フォローの運用設定</h2>
      <p className="mt-1 text-sm text-gray-600">
        対応時間・返信目安・担当者を設定します。有効にすると患者画面に「対応の見通し」が表示されます。
      </p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {loading ? <p className="py-8 text-center text-sm text-gray-500">運用設定を読み込み中...</p> : (
        <>
          {!operations && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              まだ運用設定がありません。保存すると作成されます。
            </p>
          )}
          <div className="mt-4 space-y-4">
            <label className="block text-sm font-medium">
              対応時間（患者に表示されます）<span className="text-red-700">（必須）</span>
              <input type="text" value={draft.serviceHoursText} maxLength={2048}
                onChange={(event) => set({ serviceHoursText: event.target.value })}
                disabled={saving || !canMutate}
                placeholder="例: 平日 9:00-18:00"
                className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" />
            </label>
            <fieldset className="rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-sm font-medium">返信目安（分・1〜10080）</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {minuteInput('typicalMinutes', '通常の返信目安', draft.enabled)}
                {minuteInput('concernMinutes', '「不安がある」の返信目安')}
                {minuteInput('pharmacistRequestedMinutes', '「薬剤師に相談したい」の返信目安')}
                {minuteInput('assignedMinutes', '担当割当後の返信目安')}
                {minuteInput('escalatedMinutes', 'エスカレーション後の返信目安')}
                {minuteInput('respondedMinutes', '一次回答後の返信目安')}
              </div>
              <p className="mt-2 text-xs text-gray-500">空欄の項目は設定しません。「通常の返信目安」は患者画面に表示されます。</p>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                主担当<span className="text-red-700">（必須）</span>
                <select value={draft.primaryStaffId}
                  onChange={(event) => set({ primaryStaffId: event.target.value })}
                  disabled={saving || !canMutate}
                  className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3">
                  <option value="">選択してください</option>
                  {assignees.map((assignee) => (
                    <option key={assignee.id} value={assignee.id}>{assignee.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium">
                副担当
                <select value={draft.backupStaffId}
                  onChange={(event) => set({ backupStaffId: event.target.value })}
                  disabled={saving || !canMutate}
                  className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3">
                  <option value="">なし</option>
                  {assignees.map((assignee) => (
                    <option key={assignee.id} value={assignee.id}>{assignee.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                営業時間外の案内
                <select value={draft.afterHoursMessageCode}
                  onChange={(event) => set({
                    afterHoursMessageCode: event.target.value as FollowUpOperationsMessageCode,
                  })}
                  disabled={saving || !canMutate}
                  className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3">
                  {(Object.keys(MESSAGE_CODE_LABELS) as FollowUpOperationsMessageCode[]).map((code) => (
                    <option key={code} value={code}>{operationsMessageCodeLabel(code)}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs font-normal text-gray-500">
                  患者への表示: {operationsMessageCodePatientLine(draft.afterHoursMessageCode)}
                </span>
              </label>
              <label className="block text-sm font-medium">
                緊急時の案内
                <select value={draft.emergencyMessageCode}
                  onChange={(event) => set({
                    emergencyMessageCode: event.target.value as FollowUpOperationsMessageCode,
                  })}
                  disabled={saving || !canMutate}
                  className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3">
                  {(Object.keys(MESSAGE_CODE_LABELS) as FollowUpOperationsMessageCode[]).map((code) => (
                    <option key={code} value={code}>{operationsMessageCodeLabel(code)}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs font-normal text-gray-500">
                  患者への表示: {operationsMessageCodePatientLine(draft.emergencyMessageCode)}
                </span>
              </label>
            </div>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
              <input type="checkbox" checked={draft.enabled}
                onChange={(event) => set({ enabled: event.target.checked })}
                disabled={saving || !canMutate} className="h-5 w-5" />
              運用設定を有効にする（患者画面に「対応の見通し」を表示）
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-amber-700">{dirty ? '未保存の変更があります。' : '保存済みです。'}</p>
            <button type="button" onClick={() => void save()}
              disabled={!canMutate || !dirty || Boolean(validationError) || saving || loading}
              className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {saving ? '保存中…' : '運用設定を保存'}
            </button>
          </div>
          {validationError && dirty && (
            <p role="alert" className="mt-2 text-sm text-red-700">{validationError}</p>
          )}
        </>
      )}
    </section>
  )
}
