'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { ApiError, api } from '../../../lib/api'
import { pharmacyGrowthApi } from '../growth-loop/api'
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

export function shouldConfirmAction(action: Pick<StatusAction, 'confirm'>): boolean {
  return Boolean(action.confirm)
}

export function actionConfirmationMessage(action: Pick<StatusAction, 'label'>): string {
  return `「${action.label}」を実行します。状態変更は取り消せません。患者へLINE通知される場合があります。よろしいですか？`
}

const SAFE_ACTION_ERRORS = new Set([
  '受付内容の確認が完了していません',
  '処方せんの使用期限を確認してください',
])

export function prescriptionActionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return error.detail && SAFE_ACTION_ERRORS.has(error.detail)
      ? error.detail
      : '処方せんの状態が変わったか、この操作を実行できない状態です。最新状態を読み込みました。'
  }
  return '状態を更新できませんでした。'
}

// Resolves to the fetched blob only if this request is still the latest one
// in flight; resolves to null (never throws) if a newer request superseded
// it, whether this request succeeded or failed. A genuine failure of the
// still-latest request rethrows so the caller can surface it.
export async function loadPrescriptionImage(
  fetchImage: () => Promise<Blob>,
  requestId: number,
  latestRequestId: { current: number },
): Promise<Blob | null> {
  try {
    const blob = await fetchImage()
    return requestId === latestRequestId.current ? blob : null
  } catch (error) {
    if (requestId !== latestRequestId.current) return null
    throw error
  }
}

export default function PrescriptionQueuePage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<PrescriptionQueueItem[]>([])
  const [stats, setStats] = useState<PrescriptionStats>({
    pending_count: 0, oldest_wait_at: null, draft_count: 0, received_count: 0,
    needs_resubmission_count: 0, accepted_count: 0, ready_count: 0,
    closed_count: 0, cancelled_count: 0, total_count: 0,
  })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [tab, setTab] = useState<PrescriptionQueueTab>(() => {
    if (typeof window === 'undefined') return 'received'
    const value = new URLSearchParams(window.location.search).get('status')
    return ['all', 'draft', 'received', 'needs_resubmission', 'accepted', 'ready', 'closed', 'cancelled'].includes(value ?? '')
      ? value as PrescriptionQueueTab
      : 'received'
  })
  const [loading, setLoading] = useState(true)
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
  const imageRequestRef = useRef(0)

  const load = useCallback(async (cursor?: string) => {
    if (!selectedAccountId) return
    setLoading(true)
    setError('')
    try {
      const [queue, nextStats] = await Promise.all([
        prescriptionAdminApi.list(selectedAccountId, cursor, tab === 'all' ? undefined : tab),
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
  }, [selectedAccountId, tab])

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
        pharmacyGrowthApi.sources(selectedAccountId),
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

  const updateUrl = useCallback((nextTab: PrescriptionQueueTab, submissionId?: string | null) => {
    const url = new URL(window.location.href)
    if (nextTab === 'received') url.searchParams.delete('status')
    else url.searchParams.set('status', nextTab)
    if (submissionId) url.searchParams.set('submission', submissionId)
    else url.searchParams.delete('submission')
    window.history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const submissionId = searchParams.get('submission')
    if (submissionId) void openDetail(submissionId)
  }, [openDetail])

  useEffect(() => {
    if (!detail) return
    const refresh = () => void openDetail(detail.submission.id)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [detail, openDetail])

  const closeViewer = useCallback(() => {
    imageRequestRef.current += 1
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
    const requestId = ++imageRequestRef.current
    setError('')
    try {
      const blob = await loadPrescriptionImage(
        () => prescriptionAdminApi.image(selectedAccountId, detail.submission.id, file.id),
        requestId,
        imageRequestRef,
      )
      if (!blob) return
      const url = URL.createObjectURL(blob)
      setViewer((current) => {
        if (current) URL.revokeObjectURL(current.url)
        return { index, url }
      })
    } catch {
      setError('画像を取得できませんでした。再度お試しください。')
    }
  }, [detail, selectedAccountId])

  const moveViewer = useCallback((index: number) => {
    const file = readyFiles[index]
    if (file) void openImage(file, index)
  }, [openImage, readyFiles])

  const runAction = async (action: StatusAction) => {
    if (!selectedAccountId || !detail || acting) return
    if (shouldConfirmAction(action) && !window.confirm(actionConfirmationMessage(action))) return
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
        setError(prescriptionActionError(caught))
        await Promise.all([openDetail(detail.submission.id), load()])
      } else {
        setError(prescriptionActionError(caught))
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
          <h1 className="text-2xl font-bold text-gray-900">処方せん受付</h1>
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
        onTabChange={(nextTab) => {
          setTab(nextTab)
          updateUrl(nextTab, detail?.submission.id)
        }}
        onOpenDetail={(id) => {
          setActionMessage('')
          closeViewer()
          updateUrl(tab, id)
          void openDetail(id).then(() => {
            document.getElementById('prescription-detail-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          })
        }}
        onLoadMore={(cursor) => void load(cursor)}
      />

      {detail && <PrescriptionReviewEditor
        accountId={selectedAccountId}
        submissionId={detail.submission.id}
        source={detail.source}
        validity={detail.validity}
        medicalSources={medicalSources}
        onSaveSource={async (accountId, submissionId, body) => {
          const response = await pharmacyGrowthApi.classifySource(accountId, submissionId, body)
          if (!response.success) throw new Error(response.error)
        }}
        onSaveValidity={async (accountId, submissionId, body) => {
          const response = await pharmacyGrowthApi.saveValidity(accountId, submissionId, body)
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
        actionError={error}
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
