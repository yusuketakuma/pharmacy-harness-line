'use client'

import React from 'react'
import type {
  FulfillmentDecision,
  FulfillmentMethod,
  FulfillmentQuote,
} from './api'

const DECISION_LABELS: Record<FulfillmentDecision, string> = {
  fulfillable: '受付可能',
  conditional: '条件付きで受付可能',
  needs_confirmation: '追加確認が必要',
  not_fulfillable: '今回は受付不可',
}

const REASON_OPTIONS = [
  ['original_required', '処方せん原本の確認'],
  ['unclear_image', '画像の追加確認'],
  ['stock_check', '在庫の確認'],
  ['pickup_time', '受取時間の確認'],
] as const

const METHOD_LABELS: Record<FulfillmentMethod, string> = {
  PICKUP: '薬局で受け取り',
  DELIVERY: '配送',
  HOME_VISIT: '訪問',
  FACILITY_DELIVERY: '施設へ配送',
}

export interface FulfillmentQuoteDraft {
  decision: FulfillmentDecision
  reasonCodes: string[]
  requirements: Array<{ code: string; status: 'pending' | 'satisfied' }>
  readyAt: string
  validUntil: string
  method: FulfillmentMethod | ''
}

const dateTimeInputValue = (value: string | null | undefined) => value ? value.slice(0, 16) : ''

export function fulfillmentQuoteDraft(quote: FulfillmentQuote | null): FulfillmentQuoteDraft {
  return {
    decision: quote?.decision ?? 'needs_confirmation',
    reasonCodes: quote?.reasonCodes ?? [],
    requirements: quote?.requirements ?? [],
    readyAt: dateTimeInputValue(quote?.estimatedReadyAt),
    validUntil: dateTimeInputValue(quote?.validUntil),
    method: quote?.fulfillmentMethod ?? '',
  }
}

export function FulfillmentQuoteEditor({
  quote,
  draft,
  saving,
  onChange,
  onSave,
}: {
  quote: FulfillmentQuote | null
  draft: FulfillmentQuoteDraft
  saving: boolean
  onChange: (draft: FulfillmentQuoteDraft) => void
  onSave: () => void
}) {
  const update = (values: Partial<FulfillmentQuoteDraft>) => onChange({ ...draft, ...values })

  return (
    <section className="rounded-lg border border-green-200 bg-green-50 p-4" aria-labelledby="prescription-answer-title">
      <h3 id="prescription-answer-title" className="font-semibold">受付回答</h3>
      <p className="mt-1 text-sm text-gray-600">受付可否・確認事項・準備予定を登録すると、患者さんへの案内まで進められます。</p>
      <label className="mt-3 block text-sm font-medium">
        受付可否
        <select value={draft.decision} onChange={(event) => {
          const decision = event.target.value as FulfillmentDecision
          update({
            decision,
            requirements: decision === 'conditional' && draft.requirements.length === 0
              ? [{ code: 'original_required', status: 'pending' }]
              : draft.requirements,
          })
        }} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
          {Object.entries(DECISION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <fieldset className="mt-3 space-y-2">
        <legend className="text-sm font-medium">確認項目（自由記述なし）</legend>
        {REASON_OPTIONS.map(([code, label]) => <label key={code} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.reasonCodes.includes(code)} onChange={(event) => update({
          reasonCodes: event.target.checked
            ? [...draft.reasonCodes, code]
            : draft.reasonCodes.filter((item) => item !== code),
          requirements: event.target.checked
            ? draft.requirements.some((item) => item.code === code)
              ? draft.requirements
              : [...draft.requirements, { code, status: 'pending' }]
            : draft.requirements.filter((item) => item.code !== code),
        })} />{label}</label>)}
      </fieldset>
      {draft.requirements.length > 0 && <div className="mt-3 space-y-2">
        <p className="text-sm font-medium">条件の状態</p>
        {draft.requirements.map((requirement) => <label key={requirement.code} className="flex items-center justify-between gap-2 text-sm">
          <span>{REASON_OPTIONS.find(([code]) => code === requirement.code)?.[1] ?? requirement.code}</span>
          <select value={requirement.status} onChange={(event) => update({
            requirements: draft.requirements.map((item) => item.code === requirement.code
              ? { ...item, status: event.target.value as 'pending' | 'satisfied' }
              : item),
          })} className="rounded border border-gray-300 bg-white px-2 py-1">
            <option value="pending">未確認</option>
            <option value="satisfied">確認済み</option>
          </select>
        </label>)}
      </div>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">準備予定時刻<input type="datetime-local" value={draft.readyAt} onChange={(event) => update({ readyAt: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" /></label>
        <label className="text-sm font-medium">受取方法<select value={draft.method} onChange={(event) => update({ method: event.target.value as FulfillmentMethod | '' })} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">未定</option>{Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label className="mt-3 block max-w-sm text-sm font-medium">回答の有効期限<input type="datetime-local" value={draft.validUntil} onChange={(event) => update({ validUntil: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" /></label>
      {quote && <p className="mt-3 text-xs text-gray-600">第{quote.revision}版・{DECISION_LABELS[quote.decision]}・状態 {quote.status}</p>}
      <button type="button" onClick={onSave} disabled={saving} className="mt-4 rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? '保存中…' : '受付内容を保存'}</button>
    </section>
  )
}
