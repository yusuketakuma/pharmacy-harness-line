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
  confirm?: boolean
  danger?: boolean
}

export function actionsForStatus(status: PrescriptionStatus): StatusAction[] {
  if (status === 'received') return [
    { id: 'accept', label: '確認して受付する', confirm: true },
    { id: 'request_resubmission', label: '再送を依頼', confirm: true },
    { id: 'cancel', label: 'キャンセル', confirm: true, danger: true },
  ]
  if (status === 'accepted') return [
    { id: 'ready', label: '準備完了にする', confirm: true },
    { id: 'request_resubmission', label: '再送を依頼', confirm: true },
    { id: 'cancel', label: 'キャンセル', confirm: true, danger: true },
  ]
  if (status === 'ready') return [
    { id: 'close', label: '受け渡し完了', confirm: true },
    { id: 'cancel', label: 'キャンセル', confirm: true, danger: true },
  ]
  if (status === 'draft' || status === 'needs_resubmission') {
    return [{ id: 'cancel', label: 'キャンセル', confirm: true, danger: true }]
  }
  return []
}

export function PrescriptionDetailPanel({
  detail,
  loading,
  disabled = false,
  readyFiles,
  quote,
  quoteDraft,
  quoteSaving,
  acting,
  actionMessage,
  actionError,
  reason,
  onOpenImage,
  onQuoteChange,
  onQuoteSave,
  onReasonChange,
  onAction,
}: {
  detail: PrescriptionDetail | null
  loading: boolean
  disabled?: boolean
  readyFiles: PrescriptionFile[]
  quote: FulfillmentQuote | null
  quoteDraft: FulfillmentQuoteDraft
  quoteSaving: boolean
  acting: boolean
  actionMessage: string
  actionError: string
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
        <fieldset disabled={disabled || loading || acting || quoteSaving} className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="prescription-detail-title" className="text-xl font-bold">処方せん詳細</h2>
              <p className="mt-1 font-semibold">LINE表示名: {detail.submission.patient_display_name || '未確認'}</p>
              <p className="mt-1 text-sm text-gray-600">氏名は画像・アンケートと照合してください。</p>
              <p className="mt-1 text-sm text-gray-500">状態: {statusLabel(detail.submission.status)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/prescriptions/print?submission_id=${encodeURIComponent(detail.submission.id)}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700"
              >
                印刷用画面
              </Link>
              <Link href={`/chats?friend=${encodeURIComponent(detail.submission.friend_id)}`} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">個別チャットを開く</Link>
            </div>
          </div>

          {actionError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
          {actionMessage && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{actionMessage}</p>}

          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-gray-500">受付日時</dt><dd>{formatDate(detail.submission.requested_at)}</dd></div>
            <div><dt className="text-gray-500">受取希望</dt><dd>{formatDate(detail.submission.desired_pickup_at)}</dd></div>
            <div><dt className="text-gray-500">再送理由</dt><dd>{reasonLabel(detail.submission.resubmission_reason_code)}</dd></div>
          </dl>

          <div className="space-y-1 text-sm">
            <h3 className="font-semibold">アンケート回答の確認時点</h3>
            {detail.intake ? <>
              <p>この処方せんに紐付く回答: 第{detail.intake.revision}版（{formatDate(detail.intake.submitted_at)}）</p>
              <p>最新回答: 第{detail.intake.latest_revision}版（{formatDate(detail.intake.latest_submitted_at)}）</p>
              <p>薬局の確認記録: {detail.intake.reviewed_at ? formatDate(detail.intake.reviewed_at) : '未確認'}</p>
              {detail.intake.latest_revision > detail.intake.revision && <p role="status" className="text-amber-800">より新しい回答があります。「患者アンケート」で内容を確認してください。</p>}
            </> : <p>{detail.intake === null ? 'アンケートとの紐付けを確認できません。対象患者を確認してください。' : 'アンケートの回答時刻は未確認です。'}</p>}
          </div>

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
        </fieldset>
      )}
    </section>
  )
}
