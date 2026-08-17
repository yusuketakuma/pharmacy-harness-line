'use client'

import Link from 'next/link'
import React from 'react'
import type {
  FulfillmentQuote,
  PrescriptionAdminAction,
  PrescriptionDetail,
  PrescriptionFile,
  PrescriptionStatus,
} from './api'
import {
  FulfillmentQuoteEditor,
  type FulfillmentQuoteDraft,
} from './FulfillmentQuoteEditor'
import { formatDate, statusLabel } from './PrescriptionQueueOverview'

const REASON_LABELS: Record<string, string> = {
  blurred: '画像がぼやけています',
  cropped: '処方せんの一部が切れています',
  glare: '光が反射しています',
  unreadable: '文字を読み取れません',
  missing_page: '不足しているページがあります',
  admin_cancelled: '薬局でキャンセルしました',
}

export const reasonLabel = (reason: string | null) => reason ? REASON_LABELS[reason] ?? reason : 'なし'

export interface StatusAction {
  id: PrescriptionAdminAction
  label: string
  danger?: boolean
}

export function actionsForStatus(status: PrescriptionStatus): StatusAction[] {
  if (status === 'received') return [
    { id: 'accept', label: '確認して受付する' },
    { id: 'request_resubmission', label: '再送を依頼' },
    { id: 'cancel', label: 'キャンセル', danger: true },
  ]
  if (status === 'accepted') return [
    { id: 'ready', label: '準備完了にする' },
    { id: 'request_resubmission', label: '再送を依頼' },
    { id: 'cancel', label: 'キャンセル', danger: true },
  ]
  if (status === 'ready') return [
    { id: 'close', label: '受け渡し完了' },
    { id: 'cancel', label: 'キャンセル', danger: true },
  ]
  if (status === 'draft' || status === 'needs_resubmission') {
    return [{ id: 'cancel', label: 'キャンセル', danger: true }]
  }
  return []
}

export function PrescriptionDetailPanel({
  detail,
  loading,
  readyFiles,
  quote,
  quoteDraft,
  quoteSaving,
  acting,
  reason,
  onOpenImage,
  onQuoteChange,
  onQuoteSave,
  onReasonChange,
  onAction,
}: {
  detail: PrescriptionDetail | null
  loading: boolean
  readyFiles: PrescriptionFile[]
  quote: FulfillmentQuote | null
  quoteDraft: FulfillmentQuoteDraft
  quoteSaving: boolean
  acting: boolean
  reason: string
  onOpenImage: (file: PrescriptionFile, index: number) => void
  onQuoteChange: (draft: FulfillmentQuoteDraft) => void
  onQuoteSave: () => void
  onReasonChange: (reason: string) => void
  onAction: (action: StatusAction) => void
}) {
  if (!detail && !loading) return null
  const actions = detail ? actionsForStatus(detail.submission.status) : []

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="prescription-detail-title">
      {loading && !detail ? <p>詳細を読み込み中...</p> : detail && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="prescription-detail-title" className="text-xl font-bold">処方せん詳細</h2>
              <p className="mt-1 text-sm text-gray-500">状態: {statusLabel(detail.submission.status)}</p>
            </div>
            <Link href={`/chats?friend=${encodeURIComponent(detail.submission.friend_id)}`} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">個別チャットを開く</Link>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-gray-500">受付日時</dt><dd>{formatDate(detail.submission.requested_at)}</dd></div>
            <div><dt className="text-gray-500">受取希望</dt><dd>{formatDate(detail.submission.desired_pickup_at)}</dd></div>
            <div><dt className="text-gray-500">再送理由</dt><dd>{reasonLabel(detail.submission.resubmission_reason_code)}</dd></div>
          </dl>

          <div>
            <h3 className="font-semibold">画像</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {readyFiles.map((file, index) => (
                <button key={file.id} type="button" onClick={() => onOpenImage(file, index)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">画像 {file.position} を表示</button>
              ))}
              {readyFiles.length === 0 && <p className="text-sm text-gray-500">表示できる画像はありません。</p>}
            </div>
          </div>

          {detail.submission.status === 'received' && (
            <FulfillmentQuoteEditor
              quote={quote}
              draft={quoteDraft}
              saving={quoteSaving}
              onChange={onQuoteChange}
              onSave={onQuoteSave}
            />
          )}

          {actions.some((action) => action.id === 'request_resubmission') && (
            <label className="block max-w-md text-sm font-medium text-gray-700">
              再送理由
              <select value={reason} onChange={(event) => onReasonChange(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
                {Object.entries(REASON_LABELS).filter(([key]) => key !== 'admin_cancelled').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <button key={action.id} type="button" onClick={() => onAction(action)} disabled={acting} className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${action.danger ? 'bg-red-600' : 'bg-green-600'}`}>{action.label}</button>
            ))}
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-medium">操作履歴 ({detail.events.length})</summary>
            <ol className="mt-2 space-y-2 text-sm text-gray-600">
              {detail.events.map((event) => <li key={event.id}>{formatDate(event.created_at)}: {event.to_status ? statusLabel(event.to_status) : event.event_type}{event.reason_code ? ` - ${reasonLabel(event.reason_code)}` : ''}</li>)}
            </ol>
          </details>
        </div>
      )}
    </section>
  )
}
