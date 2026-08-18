'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { ApiError, api } from '../../../lib/api'
import {
  prescriptionAdminApi,
  type PrescriptionDetail,
  type PrescriptionFile,
  type PrescriptionQueueItem,
  type PrescriptionStats,
  type FulfillmentQuote,
  type MedicalSource,
  type PrescriptionNotificationStatus,
} from './api'
import {
  fulfillmentQuoteDraft,
  type FulfillmentQuoteDraft,
} from './FulfillmentQuoteEditor'
import {
  PrescriptionDetailPanel,
  type StatusAction,
} from './PrescriptionDetailPanel'
import { PrescriptionImageViewer } from './PrescriptionImageViewer'
import {
  isTemporaryDeploymentError,
  PrescriptionQueueOverview,
  type PrescriptionQueueTab,
} from './PrescriptionQueueOverview'
import { PrescriptionReviewEditor } from './PrescriptionReviewEditor'

export function actionNotice(status: PrescriptionNotificationStatus): string {
  switch (status) {
    case 'sent': return '状態を更新し、LINEへ通知しました。'
    case 'already_sent': return '状態を更新しました。LINE通知は通知済みです。'
    case 'failed': return '状態を更新しました。LINE通知は再試行待ちです。'
    case 'superseded': return '状態を更新しました。新しい状態があるため通知を送りませんでした。'
    case 'skipped': return '状態を更新しました。LINEへ通知できないため、個別にご連絡ください。'
  }
}

export function shouldConfirmAction(action: Pick<StatusAction, 'danger'>): boolean {
  return Boolean(action.danger)
}

export default function PrescriptionQueuePage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<PrescriptionQueueItem[]>([])
  const [stats, setStats] = useState<PrescriptionStats>({ pending_count: 0, oldest_wait_at: null })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [tab, setTab] = useState<PrescriptionQueueTab>('received')
  const [loading, setLoading] = useState(false)
  const [temporaryError, setTemporaryError] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null)
  const [quote, setQuote] = useState<FulfillmentQuote | null>(null)
  const [quoteDraft, setQuoteDraft] = useState<FulfillmentQuoteDraft>(
    () => fulfillmentQuoteDraft(null),
  )
  const [quoteSaving, setQuoteSaving] = useState(false)
  const [medicalSources, setMedicalSources] = useState<MedicalSource[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [reason, setReason] = useState('blurred')
  const [viewer, setViewer] = useState<{ index: number; url: string } | null>(null)

  const load = useCallback(async (cursor?: string) => {
    if (!selectedAccountId) return
    setLoading(true)
    setError('')
    try {
      const [queue, nextStats] = await Promise.all([
        prescriptionAdminApi.list(selectedAccountId, cursor),
        prescriptionAdminApi.stats(selectedAccountId),
      ])
      setItems((current) => cursor ? [...current, ...queue.items] : queue.items)
      setNextCursor(queue.nextCursor)
      setStats(nextStats.stats)
      setTemporaryError(false)
    } catch (caught) {
      setTemporaryError(isTemporaryDeploymentError(caught))
      setError(isTemporaryDeploymentError(caught) ? '' : '処方せん一覧を取得できませんでした。')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    setItems([])
    setDetail(null)
    setQuote(null)
    void load()
  }, [load, selectedAccountId])

  const openDetail = useCallback(async (id: string) => {
    if (!selectedAccountId) return
    setDetailLoading(true)
    setError('')
    try {
      const [nextDetail, nextQuote, sourceResponse] = await Promise.all([
        prescriptionAdminApi.detail(selectedAccountId, id),
        prescriptionAdminApi.fulfillmentQuote(selectedAccountId, id),
        api.pharmacyGrowth.sources(selectedAccountId),
      ])
      setDetail(nextDetail)
      setQuote(nextQuote.quote)
      setMedicalSources(sourceResponse.success ? sourceResponse.data : [])
      setQuoteDraft(fulfillmentQuoteDraft(nextQuote.quote))
      setTemporaryError(false)
    } catch (caught) {
      setTemporaryError(isTemporaryDeploymentError(caught))
      setError(isTemporaryDeploymentError(caught) ? '' : '処方せん詳細を取得できませんでした。')
    } finally {
      setDetailLoading(false)
    }
  }, [selectedAccountId])

  const closeViewer = useCallback(() => {
    setViewer((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return null
    })
  }, [])

  useEffect(() => closeViewer, [closeViewer])

  const readyFiles = detail?.files
    .filter((file) => file.state === 'ready' && file.revision === detail.submission.active_revision)
    .sort((a, b) => a.position - b.position) ?? []

  const openImage = useCallback(async (file: PrescriptionFile, index: number) => {
    if (!selectedAccountId || !detail) return
    try {
      const blob = await prescriptionAdminApi.image(selectedAccountId, detail.submission.id, file.id)
      closeViewer()
      setViewer({ index, url: URL.createObjectURL(blob) })
    } catch {
      setError('画像を取得できませんでした。再度お試しください。')
    }
  }, [closeViewer, detail, selectedAccountId])

  const moveViewer = useCallback((index: number) => {
    const file = readyFiles[index]
    if (file) void openImage(file, index)
  }, [openImage, readyFiles])

  const runAction = async (action: StatusAction) => {
    if (!selectedAccountId || !detail || acting) return
    if (shouldConfirmAction(action) && !window.confirm(`「${action.label}」を実行しますか？`)) return
    setActing(true)
    setError('')
    setActionMessage('')
    try {
      const result = await prescriptionAdminApi.action(
        selectedAccountId,
        detail.submission.id,
        action.id,
        detail.submission.updated_at,
        action.id === 'request_resubmission' ? reason : undefined,
        crypto.randomUUID(),
      )
      setActionMessage(actionNotice(result.notification.status))
      await Promise.all([openDetail(detail.submission.id), load()])
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError('ほかのスタッフが先に更新しました。最新状態を読み込みました。')
        await Promise.all([openDetail(detail.submission.id), load()])
      } else {
        setError('状態を更新できませんでした。')
      }
    } finally {
      setActing(false)
    }
  }

  const saveQuote = async () => {
    if (!selectedAccountId || !detail || quoteSaving) return
    setQuoteSaving(true)
    setError('')
    try {
      const result = await prescriptionAdminApi.saveFulfillmentQuote(
        selectedAccountId,
        detail.submission.id,
        {
          decision: quoteDraft.decision,
          reasonCodes: quoteDraft.reasonCodes,
          requirements: quoteDraft.requirements,
          estimatedReadyAt: quoteDraft.readyAt ? new Date(quoteDraft.readyAt).toISOString() : null,
          validUntil: quoteDraft.validUntil ? new Date(quoteDraft.validUntil).toISOString() : null,
          ...(quoteDraft.method ? { fulfillmentMethod: quoteDraft.method } : {}),
        },
      )
      setQuote(result.quote)
      setQuoteDraft((current) => ({ ...current, requirements: result.quote.requirements }))
    } catch {
      setError('受付内容を保存できませんでした。')
    } finally {
      setQuoteSaving(false)
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">処方せん事前送信</h1>
          <p className="mt-1 text-sm text-gray-500">患者さんから届いた画像とアンケートを確認し、受付状況を更新します。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
      </div>

      <PrescriptionQueueOverview
        items={items}
        stats={stats}
        tab={tab}
        loading={loading}
        temporaryError={temporaryError}
        error={error}
        nextCursor={nextCursor}
        onTabChange={setTab}
        onOpenDetail={(id) => void openDetail(id)}
        onLoadMore={(cursor) => void load(cursor)}
      />

      {detail && <PrescriptionReviewEditor
        accountId={selectedAccountId}
        submissionId={detail.submission.id}
        source={detail.source}
        validity={detail.validity}
        medicalSources={medicalSources}
        onSaveSource={async (accountId, submissionId, body) => {
          const response = await api.pharmacyGrowth.classifySource(accountId, submissionId, body)
          if (!response.success) throw new Error(response.error)
        }}
        onSaveValidity={async (accountId, submissionId, body) => {
          const response = await api.pharmacyGrowth.saveValidity(accountId, submissionId, body)
          if (!response.success) throw new Error(response.error)
        }}
        onSaved={() => void openDetail(detail.submission.id)}
      />}

      <PrescriptionDetailPanel
        detail={detail}
        loading={detailLoading}
        readyFiles={readyFiles}
        quote={quote}
        quoteDraft={quoteDraft}
        quoteSaving={quoteSaving}
        acting={acting}
        actionMessage={actionMessage}
        reason={reason}
        onOpenImage={(file, index) => void openImage(file, index)}
        onQuoteChange={setQuoteDraft}
        onQuoteSave={() => void saveQuote()}
        onReasonChange={setReason}
        onAction={(action) => void runAction(action)}
      />

      {viewer && <PrescriptionImageViewer imageUrl={viewer.url} position={viewer.index + 1} total={readyFiles.length} onClose={closeViewer} onPrevious={() => moveViewer(viewer.index - 1)} onNext={() => moveViewer(viewer.index + 1)} />}
    </div>
  )
}
