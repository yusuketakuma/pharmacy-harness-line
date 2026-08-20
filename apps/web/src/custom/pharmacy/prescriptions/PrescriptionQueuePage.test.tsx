import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  actionsForStatus,
  reasonLabel,
} from './PrescriptionDetailPanel.js'
import {
  actionConfirmationMessage,
  actionNotice,
  prescriptionActionError,
  shouldConfirmAction,
} from './PrescriptionQueuePage.js'
import { ApiError } from '../../../lib/api.js'
import { PrescriptionImageViewer } from './PrescriptionImageViewer.js'
import {
  PrescriptionQueueEmptyState,
  isTemporaryDeploymentError,
  statusLabel,
} from './PrescriptionQueueOverview.js'
import {
  FulfillmentQuoteEditor,
  fulfillmentStatusLabel,
  fulfillmentQuoteDraft,
} from './FulfillmentQuoteEditor.js'
import { PrescriptionReviewEditor } from './PrescriptionReviewEditor.js'
import {
  canAcknowledgePrint,
  printAcknowledgementMessage,
  printablePrescriptionFiles,
} from './PrescriptionPrintPage.js'

describe('prescription admin UI contract', () => {
  it('shows fixed Japanese status and resubmission reason labels', () => {
    expect(statusLabel('needs_resubmission')).toBe('再送依頼中')
    expect(reasonLabel('glare')).toBe('光が反射しています')
    expect(reasonLabel(null)).toBe('なし')
  })

  it('requires confirmation independently from danger styling and explains cancellation effects', () => {
    const close = actionsForStatus('ready')[0]
    const cancel = actionsForStatus('ready')[1]

    expect(close).toMatchObject({ confirm: true })
    expect(close.danger).toBeUndefined()
    expect(shouldConfirmAction(close)).toBe(true)
    expect(cancel).toMatchObject({ danger: true, confirm: true })
    expect(actionConfirmationMessage(cancel)).toContain('LINE通知')
    expect(actionConfirmationMessage(cancel)).toContain('取り消せません')
    expect(actionNotice('failed')).toContain('再試行待ち')
    expect(actionNotice('already_sent')).toContain('通知済み')
  })

  it('does not misdiagnose every action conflict as another staff update', () => {
    const validity = Object.assign(new ApiError(409), {
      detail: '処方せんの使用期限を確認してください',
    })
    const conflict = Object.assign(new ApiError(409), {
      detail: 'Prescription changed or action is invalid',
    })

    expect(prescriptionActionError(validity)).toBe('処方せんの使用期限を確認してください')
    expect(prescriptionActionError(conflict)).toContain('状態が変わったか')
    expect(prescriptionActionError(conflict)).not.toContain('ほかのスタッフ')
  })

  it('offers only state-valid actions', () => {
    expect(actionsForStatus('received').map((action) => action.id)).toEqual([
      'accept', 'request_resubmission', 'cancel',
    ])
    expect(actionsForStatus('ready').map((action) => action.id)).toEqual(['close', 'cancel'])
    expect(actionsForStatus('closed')).toEqual([])
  })

  it('treats 404 and 503 as temporary deployment errors', () => {
    expect(isTemporaryDeploymentError({ status: 404 })).toBe(true)
    expect(isTemporaryDeploymentError({ status: 503 })).toBe(true)
    expect(isTemporaryDeploymentError({ status: 500 })).toBe(false)
  })

  it('maps a saved fulfillment quote into native form values', () => {
    expect(fulfillmentQuoteDraft(null)).toMatchObject({
      decision: 'needs_confirmation',
      readyAt: '',
      validUntil: '',
      method: '',
    })
    expect(fulfillmentQuoteDraft({
      decision: 'fulfillable',
      reasonCodes: ['stock_check'],
      requirements: [{ code: 'stock_check', status: 'pending' }],
      estimatedReadyAt: '2026-08-17T15:30:00.000Z',
      validUntil: '2026-08-17T16:00:00.000Z',
      fulfillmentMethod: 'PICKUP',
    } as never)).toMatchObject({
      decision: 'fulfillable',
      readyAt: '2026-08-18T00:30',
      validUntil: '2026-08-18T01:00',
      method: 'PICKUP',
    })
    expect(fulfillmentQuoteDraft({
      estimatedReadyAt: '2026-08-17T15:30:00+09:00',
      validUntil: '2026-08-17T16:00:00+09:00',
    } as never)).toMatchObject({
      readyAt: '2026-08-17T15:30',
      validUntil: '2026-08-17T16:00',
    })
  })

  it('renders the fulfillment editor as a controlled form', () => {
    const html = renderToStaticMarkup(<FulfillmentQuoteEditor
      quote={null}
      draft={fulfillmentQuoteDraft(null)}
      saving={false}
      onChange={() => undefined}
      onSave={() => undefined}
    />)
    expect(html).toContain('受付回答')
    expect(html).not.toContain('FulfillmentQuote')
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('受付内容を保存')
    expect(fulfillmentStatusLabel('PHARMACIST_REVIEW_REQUIRED')).toBe('薬剤師の確認が必要')
  })

  it('renders manual source classification and prescription validity controls', () => {
    const html = renderToStaticMarkup(<PrescriptionReviewEditor
      accountId="account-1"
      submissionId="submission-1"
      source={{ source_id: 'source-1', classification: 'primary', display_name: 'Clinic A' } as never}
      validity={null}
      medicalSources={[{
        id: 'source-1', display_name: 'Clinic A', classification: 'primary', is_active: 1,
      }]}
      onSaved={() => undefined}
    />)

    expect(html).toContain('発行元分類')
    expect(html).toContain('Clinic A')
    expect(html).toContain('処方せん使用期限')
    expect(html).toContain('type="date"')
    expect(html).toContain('交付日を含めて4日')
  })

  it('renders retry guidance instead of a false empty queue', () => {
    const html = renderToStaticMarkup(<PrescriptionQueueEmptyState temporaryError />)
    expect(html).toContain('機能を準備中です')
    expect(html).toContain('再読み込み')
    expect(html).not.toContain('処方せんはありません')
  })

  it('renders semantic viewer controls without a persistent image URL', () => {
    const html = renderToStaticMarkup(
      <PrescriptionImageViewer
        imageUrl="blob:private-image"
        position={1}
        total={2}
        onClose={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
      />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('拡大')
    expect(html).toContain('回転')
    expect(html).toContain('前の画像')
    expect(html).toContain('次の画像')
    expect(html).toContain('aria-modal="true"')
    expect(html).not.toContain('https://worker.example')
  })

  it('keeps review drafts, queue notices, counts, and image requests scoped to the current record', () => {
    const review = readFileSync(new URL('./PrescriptionReviewEditor.tsx', import.meta.url), 'utf8')
    const page = readFileSync(new URL('./PrescriptionQueuePage.tsx', import.meta.url), 'utf8')
    const overview = readFileSync(new URL('./PrescriptionQueueOverview.tsx', import.meta.url), 'utf8')

    expect(review).toContain('}, [source, submissionId])')
    expect(review).toContain('}, [submissionId, validity])')
    expect(page).toContain('const [loading, setLoading] = useState(true)')
    expect(page).toContain('setActionMessage(\'\')')
    expect(page).toContain('imageRequestRef.current')
    expect(page).toContain("searchParams.get('submission')")
    expect(page).toContain("window.addEventListener('focus'")
    expect(page).toContain("tab === 'all' ? undefined : tab")
    expect(page).toContain('}, [selectedAccountId, tab])')
    expect(overview).toContain('stats.total_count')
    expect(overview).toContain('patient_display_name')
  })

  it('moves focus into the modal and traps tab navigation', () => {
    const viewer = readFileSync(new URL('./PrescriptionImageViewer.tsx', import.meta.url), 'utf8')
    expect(viewer).toContain('previouslyFocused')
    expect(viewer).toContain("event.key === 'Tab'")
    expect(viewer).toContain('closeButtonRef.current?.focus()')
    expect(viewer).toContain('setPointerCapture')
    expect(viewer).toContain('translate(${pan.x}px, ${pan.y}px)')
  })

  it('prints only ready files from the active revision in position order', () => {
    const files = [
      { id: 'two', revision: 2, position: 2, state: 'ready' },
      { id: 'old', revision: 1, position: 1, state: 'ready' },
      { id: 'one', revision: 2, position: 1, state: 'ready' },
      { id: 'pending', revision: 2, position: 3, state: 'pending' },
    ] as never
    expect(printablePrescriptionFiles(files, 2).map((file) => file.id)).toEqual(['one', 'two'])
  })

  it('does not allow acknowledgement before the browser print dialog was opened', () => {
    expect(canAcknowledgePrint(false, false, false)).toBe(false)
    expect(canAcknowledgePrint(true, false, false)).toBe(true)
    expect(canAcknowledgePrint(true, true, false)).toBe(false)
    expect(canAcknowledgePrint(true, false, true)).toBe(false)
    expect(printAcknowledgementMessage()).toContain('キャンセル')
    expect(printAcknowledgementMessage()).toContain('記録しない')
  })

  it('keeps acknowledged prescription images available for reprinting', () => {
    const page = readFileSync(new URL('./PrescriptionPrintPage.tsx', import.meta.url), 'utf8')

    expect(page).not.toContain("if (prepared.task.status === 'acknowledged') {\n          if (!disposed) setRecorded(true)\n          return")
    expect(page).toContain('再印刷できます')
  })

  it('shows action and image failures beside the open prescription detail', () => {
    const page = readFileSync(new URL('./PrescriptionQueuePage.tsx', import.meta.url), 'utf8')
    const detail = readFileSync(new URL('./PrescriptionDetailPanel.tsx', import.meta.url), 'utf8')

    expect(page).toContain('actionError={error}')
    expect(detail).toContain('actionError && <p role="alert"')
  })

})
