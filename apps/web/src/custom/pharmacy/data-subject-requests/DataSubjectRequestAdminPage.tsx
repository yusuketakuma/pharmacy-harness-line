'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { pharmacyIntakeAdminApi, type PharmacyPatient } from '../intake/api'
import {
  dataSubjectRequestAdminApi,
  type DataSubjectRequest,
  type DataSubjectRequestStatus,
  type DataSubjectRequestType,
} from './api'

const REQUEST_TYPE_LABELS: Record<DataSubjectRequestType, string> = {
  access: '開示請求',
  correction: '訂正請求',
  suspension: '利用停止請求',
  erasure: '消去請求',
}

const STATUS_LABELS: Record<DataSubjectRequestStatus, string> = {
  received: '受付',
  identity_verified: '本人確認済み',
  legal_hold_assessed: '法定保存判定済み',
  resolved: '対応済み',
  rejected: '対応不可として記録',
}

/** 消去・利用停止は法定保存期間に妨げられる。開示・訂正は妨げられない。 */
const RETENTION_BLOCKED_TYPES: DataSubjectRequestType[] = ['suspension', 'erasure']

export function requestTypeLabel(type: DataSubjectRequestType): string {
  return REQUEST_TYPE_LABELS[type]
}

export function requestStatusLabel(status: DataSubjectRequestStatus): string {
  return STATUS_LABELS[status]
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'
}

export function remainingRetentionText(releaseAt: string, now: Date): string {
  const months = Math.max(
    1, Math.ceil((Date.parse(releaseAt) - now.getTime()) / (30.4375 * 24 * 60 * 60 * 1000)),
  )
  if (months < 12) return `あと約${months}か月`
  const years = Math.floor(months / 12)
  const rest = months % 12
  return rest === 0 ? `あと約${years}年` : `あと約${years}年${rest}か月`
}

/** 法定保存判定の結果を、患者にそのまま説明できる日本語にする。 */
export function legalHoldExplanation(
  request: Pick<DataSubjectRequest, 'legal_hold' | 'legal_hold_release_at' | 'request_type'>,
  now: Date,
): string {
  if (request.legal_hold === null) {
    return '法定保存対象かどうかの判定がまだです。本人確認のあとに「法定保存を判定」を実行してください。'
  }
  if (request.legal_hold === 0) {
    return '対象データは法定保存期間(3年)を経過しているため、対応可能です。'
  }
  const until = request.legal_hold_release_at
    ? `${formatDate(request.legal_hold_release_at)}まで、${remainingRetentionText(request.legal_hold_release_at, now)}`
    : '保存期間の満了日を確認中'
  if (RETENTION_BLOCKED_TYPES.includes(request.request_type)) {
    return `対象データは薬剤師法施行規則に基づき法定保存期間中(${until})のため、消去・利用停止には応じられません。`
      + '応じられない理由を本人に説明したうえで「対応不可として記録」で終了してください。'
  }
  return `対象データは法定保存期間中(${until})ですが、開示・訂正は保存義務と両立するため対応できます。`
}

export function resolutionConfirmationMessage(
  decision: 'resolved' | 'rejected',
  request: Pick<DataSubjectRequest, 'request_type'>,
): string {
  const label = requestTypeLabel(request.request_type)
  return decision === 'resolved'
    ? `${label}に「対応済み」として記録します。記録は取り消せません。本人への結果連絡はこの画面からは送信されないため、別途ご自身で連絡してください。よろしいですか？`
    : `${label}を「対応不可として記録」で終了します。記録は取り消せません。応じられない理由を本人へ説明済みであることを確認してください。よろしいですか？`
}

export const ARCHIVE_IS_NOT_ERASURE_NOTICE =
  '患者のアーカイブは、法定保存中のデータを通常業務の一覧から隠すだけの運用操作です。'
  + '法的な消去対応にはならないため、消去請求はこの画面のワークフローで受付・判定・記録してください。'

export const NO_OUTBOUND_NOTICE =
  '本人への受付連絡・結果連絡はこの画面からは送信されません。記録のみを行い、連絡は担当者が個別に実施してください。'

function createRequestGate() {
  let generation = 0
  return {
    start() { generation += 1; return generation },
    abort() { generation += 1 },
    isCurrent(token: number) { return generation === token },
  }
}

const STATUS_BADGE: Record<DataSubjectRequestStatus, string> = {
  received: 'bg-amber-100 text-amber-900',
  identity_verified: 'bg-blue-100 text-blue-800',
  legal_hold_assessed: 'bg-indigo-100 text-indigo-800',
  resolved: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-100 text-gray-600',
}

export default function DataSubjectRequestAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [requests, setRequests] = useState<DataSubjectRequest[]>([])
  const [patients, setPatients] = useState<PharmacyPatient[]>([])
  const [patientId, setPatientId] = useState('')
  const [requestType, setRequestType] = useState<DataSubjectRequestType>('access')
  const [reason, setReason] = useState('')
  const [outcomeNotes, setOutcomeNotes] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const requestGate = useRef(createRequestGate()).current
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    const token = requestGate.start()
    setLoading(true)
    setError('')
    const [requestResult, patientResult] = await Promise.allSettled([
      dataSubjectRequestAdminApi.list(accountId),
      pharmacyIntakeAdminApi.list(accountId),
    ])
    if (!requestGate.isCurrent(token) || selectedAccountRef.current !== accountId) return
    if (requestResult.status === 'fulfilled') setRequests(requestResult.value.requests)
    else setError('請求の一覧を取得できませんでした。通信状態と権限を確認してください。')
    if (patientResult.status === 'fulfilled') setPatients(patientResult.value.patients)
    setLoading(false)
  }, [requestGate, selectedAccountId])

  useEffect(() => {
    setRequests([])
    setPatients([])
    setPatientId('')
    setReason('')
    setOutcomeNotes({})
    setBusy('')
    setError('')
    setMessage('')
    requestGate.abort()
    if (!selectedAccountId) {
      setLoading(false)
      return
    }
    void load()
    return () => requestGate.abort()
  }, [load, requestGate, selectedAccountId])

  async function run(token: string, action: () => Promise<unknown>, done: string, failed: string) {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    setBusy(token)
    setError('')
    setMessage('')
    try {
      await action()
      if (selectedAccountRef.current !== accountId) return
      setMessage(done)
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError(failed)
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function submitNewRequest(event: React.FormEvent) {
    event.preventDefault()
    if (!patientId || reason.trim().length === 0) {
      setError('対象の患者と、請求の内容を入力してください。')
      return
    }
    await run(
      'create',
      () => dataSubjectRequestAdminApi.create(selectedAccountId as string, {
        patientId, requestType, reason,
      }),
      '請求を受け付けとして記録しました。次に本人確認を行ってください。',
      '請求を記録できませんでした。入力内容と権限を確認してください。',
    )
    setReason('')
  }

  async function resolve(request: DataSubjectRequest, decision: 'resolved' | 'rejected') {
    const note = (outcomeNotes[request.id] ?? '').trim()
    if (note.length === 0) {
      setError('対応結果の記録には、本人へ説明した内容の記入が必要です。')
      return
    }
    if (busy || !window.confirm(resolutionConfirmationMessage(decision, request))) return
    await run(
      `resolve:${request.id}`,
      () => dataSubjectRequestAdminApi.resolve(selectedAccountId as string, request.id, {
        expectedVersion: request.version, decision, outcomeNote: note,
      }),
      '対応結果を記録しました。本人への連絡は別途実施してください。',
      decision === 'resolved'
        ? '対応済みとして記録できませんでした。法定保存期間中の消去・利用停止には応じられません。判定結果を確認してください。'
        : '対応結果を記録できませんでした。最新の状態を確認してください。',
    )
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  const now = new Date()

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">開示・訂正・利用停止・消去請求</h1>
          <p className="mt-1 text-sm text-gray-600">
            本人からの請求を受け付け、本人確認と法定保存対象の判定を経て、対応結果を記録します。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || Boolean(busy)}
          className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
        >
          再読み込み
        </button>
      </header>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p>{ARCHIVE_IS_NOT_ERASURE_NOTICE}</p>
        <p className="mt-2">{NO_OUTBOUND_NOTICE}</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</div>}

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="new-request">
        <h2 id="new-request" className="text-lg font-semibold text-gray-900">請求を受け付ける</h2>
        <form className="mt-4 space-y-3" onSubmit={(event) => void submitNewRequest(event)}>
          <div>
            <label htmlFor="request-patient" className="block text-sm text-gray-700">対象の患者</label>
            <select
              id="request-patient"
              value={patientId}
              onChange={(event) => setPatientId(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">選択してください</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}{patient.archived_at ? '（アーカイブ済み）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="request-type" className="block text-sm text-gray-700">請求の種類</label>
            <select
              id="request-type"
              value={requestType}
              onChange={(event) => setRequestType(event.target.value as DataSubjectRequestType)}
              className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {(Object.keys(REQUEST_TYPE_LABELS) as DataSubjectRequestType[]).map((type) => (
                <option key={type} value={type}>{REQUEST_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="request-reason" className="block text-sm text-gray-700">
              請求の内容・申し出の経緯
            </label>
            <textarea
              id="request-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={1000}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={busy !== ''}
            className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'create' ? '記録中…' : '請求を記録する'}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="request-list">
        <h2 id="request-list" className="text-lg font-semibold text-gray-900">受付済みの請求</h2>
        {loading && <p className="p-8 text-center text-sm text-gray-500">読み込み中...</p>}
        {!loading && requests.length === 0 && (
          <p className="p-8 text-center text-sm text-gray-500">受付済みの請求はありません。</p>
        )}
        <ul className="mt-4 space-y-4">
          {requests.map((request) => (
            <li key={request.id} className="rounded-lg border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-gray-900">{requestTypeLabel(request.request_type)}</span>
                <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_BADGE[request.status]}`}>
                  {requestStatusLabel(request.status)}
                </span>
                <span className="text-xs text-gray-500">受付 {formatDateTime(request.submitted_at)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{request.reason}</p>
              <p className="mt-2 text-sm text-gray-800">{legalHoldExplanation(request, now)}</p>
              {request.outcome_note && (
                <p className="mt-2 text-sm text-gray-600">対応記録: {request.outcome_note}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {request.status === 'received' && (
                  <button
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void run(
                      `verify:${request.id}`,
                      () => dataSubjectRequestAdminApi.verifyIdentity(
                        selectedAccountId, request.id, request.version,
                      ),
                      '本人確認済みとして記録しました。',
                      '本人確認を記録できませんでした。最新の状態を確認してください。',
                    )}
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {busy === `verify:${request.id}` ? '記録中…' : '本人確認済みにする'}
                  </button>
                )}
                {request.status === 'identity_verified' && (
                  <button
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void run(
                      `assess:${request.id}`,
                      () => dataSubjectRequestAdminApi.assessLegalHold(
                        selectedAccountId, request.id, request.version,
                      ),
                      '法定保存対象を判定しました。判定結果を確認してください。',
                      '法定保存対象を判定できませんでした。最新の状態を確認してください。',
                    )}
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {busy === `assess:${request.id}` ? '判定中…' : '法定保存を判定'}
                  </button>
                )}
              </div>
              {request.status === 'legal_hold_assessed' && (
                <div className="mt-3 space-y-2">
                  <label htmlFor={`outcome-${request.id}`} className="block text-sm text-gray-700">
                    本人へ説明した内容(対応記録)
                  </label>
                  <textarea
                    id={`outcome-${request.id}`}
                    value={outcomeNotes[request.id] ?? ''}
                    onChange={(event) => setOutcomeNotes(
                      (current) => ({ ...current, [request.id]: event.target.value }),
                    )}
                    rows={2}
                    maxLength={2000}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void resolve(request, 'resolved')}
                      className="min-h-11 rounded-lg bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-50"
                    >
                      {busy === `resolve:${request.id}` ? '記録中…' : '対応済みとして記録'}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void resolve(request, 'rejected')}
                      className="min-h-11 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-50"
                    >
                      対応不可として記録
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
