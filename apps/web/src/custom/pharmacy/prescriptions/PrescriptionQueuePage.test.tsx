import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PrescriptionImageViewer,
  PrescriptionQueueEmptyState,
  actionsForStatus,
  isTemporaryDeploymentError,
  reasonLabel,
  statusLabel,
} from './PrescriptionQueuePage.js'

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
