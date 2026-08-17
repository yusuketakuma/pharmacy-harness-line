import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  actionsForStatus,
  reasonLabel,
} from './PrescriptionDetailPanel.js'
import { PrescriptionImageViewer } from './PrescriptionImageViewer.js'
import {
  PrescriptionQueueEmptyState,
  isTemporaryDeploymentError,
  statusLabel,
} from './PrescriptionQueueOverview.js'
import {
  FulfillmentQuoteEditor,
  fulfillmentQuoteDraft,
} from './FulfillmentQuoteEditor.js'

describe('prescription admin UI contract', () => {
  it('shows fixed Japanese status and resubmission reason labels', () => {
    expect(statusLabel('needs_resubmission')).toBe('再送依頼中')
    expect(reasonLabel('glare')).toBe('光が反射しています')
    expect(reasonLabel(null)).toBe('なし')
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
      readyAt: '2026-08-17T15:30',
      validUntil: '2026-08-17T16:00',
      method: 'PICKUP',
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
    expect(html).toContain('受付内容の確認')
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('受付内容を保存')
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
})
