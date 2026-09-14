'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { ApiError } from '../../../lib/api'
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
    case 'sent': return '状態を更新しました。LINEへの送信が受け付けられました。患者への到達・既読は未確認です。'
    case 'already_sent': return '状態を更新しました。LINE通知は通知済み（送信受付済み）です。患者への到達・既読は未確認です。'
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
      : '処方せんの状態が変わったか、この操作を実行できない状態です。最新状態を確認してから、操作をやり直してください。'
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
  const [quoteRecovery, setQuoteRecovery] = useState('')
  const [medicalSources, setMedicalSources] = useState<MedicalSource[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [actionError, setActionError] = useState('')
  const [acting, setActing] = useState(false)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [reason, setReason] = useState('blurred')
  const [viewer, setViewer] = useState<{ index: number; url: string } | null>(null)
  const imageRequestRef = useRef(0)
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const selectionRef = useRef({ id: '', version: 0 })
  const actionLockRef = useRef(false)
  const quoteLockRef = useRef(false)
  const reviewLockRef = useRef(false)
  const quoteDirtyRef = useRef(false)
  const quoteBaseRevisionRef = useRef(0)

  const closeViewer = useCallback(() => {
    imageRequestRef.current += 1
    setViewer((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return null
    })
  }, [])

  useEffect(() => () => {
    listRequestRef.current += 1
    detailRequestRef.current += 1
    selectionRef.current.version += 1
  }, [])

  const load = useCallback(async (cursor?: string) => {
    if (!selectedAccountId) return
    const request = ++listRequestRef.current
    setLoading(true)
    setError('')
    try {
      const [queue, nextStats] = await Promise.all([
        prescriptionAdminApi.list(selectedAccountId, cursor, tab === 'all' ? undefined : tab),
        prescriptionAdminApi.stats(selectedAccountId),
      ])
      if (request !== listRequestRef.current) return
      setItems((current) => cursor ? [...current, ...queue.items] : queue.items)
      setNextCursor(queue.nextCursor)
      setStats(nextStats.stats)
      setTemporaryError(false)
    } catch (caught) {
      if (request !== listRequestRef.current) return
      setTemporaryError(isTemporaryDeploymentError(caught))
      setError(isTemporaryDeploymentError(caught) ? '' : '処方せん一覧を取得できませんでした。')
    } finally {
      if (request === listRequestRef.current) setLoading(false)
    }
  }, [selectedAccountId, tab])

  useEffect(() => {
    setItems([])
    void load()
    return () => { listRequestRef.current += 1 }
  }, [load, selectedAccountId])

  const openDetail = useCallback(async (id: string, discardQuoteDraft = false) => {
    if (!selectedAccountId) return false
    const request = ++detailRequestRef.current
    if (selectionRef.current.id !== id) {
      selectionRef.current = { id, version: selectionRef.current.version + 1 }
      setDetail(null)
      setQuote(null)
      setQuoteDraft(fulfillmentQuoteDraft(null))
      quoteDirtyRef.current = false
      quoteBaseRevisionRef.current = 0
      setQuoteRecovery('')
      setMedicalSources([])
      setActionMessage('')
      setActionError('')
      closeViewer()
    }
    setDetailLoading(true)
    setDetailError('')
    try {
      const [nextDetail, nextQuote, sourceResponse] = await Promise.all([
        prescriptionAdminApi.detail(selectedAccountId, id),
        prescriptionAdminApi.fulfillmentQuote(selectedAccountId, id),
        pharmacyGrowthApi.sources(selectedAccountId),
      ])
      if (request !== detailRequestRef.current) return false
      if (nextDetail.submission.id !== id || !sourceResponse.success) throw new Error('invalid detail response')
      setDetail(nextDetail)
      setQuote(nextQuote.quote)
      setMedicalSources(sourceResponse.success ? sourceResponse.data : [])
      if (!quoteDirtyRef.current || discardQuoteDraft) {
        setQuoteDraft(fulfillmentQuoteDraft(nextQuote.quote))
        quoteBaseRevisionRef.current = nextQuote.quote?.revision ?? 0
        quoteDirtyRef.current = false
      }
      if (discardQuoteDraft) setQuoteRecovery('')
      return true
    } catch {
      if (request !== detailRequestRef.current) return false
      setDetailError('最新の処方せん詳細を確認できませんでした。再読み込みが完了するまで、変更操作はできません。')
      return false
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false)
    }
  }, [closeViewer, selectedAccountId])

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
    const refresh = () => {
      if (selectionRef.current.id === detail.submission.id && !actionLockRef.current && !quoteLockRef.current && !reviewLockRef.current) {
        void openDetail(detail.submission.id)
      }
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [detail, openDetail])

  useEffect(() => closeViewer, [closeViewer])

  const readyFiles = detail?.files
    .filter((file) => file.state === 'ready' && file.revision === detail.submission.active_revision)
    .sort((a, b) => a.position - b.position) ?? []

  const openImage = useCallback(async (file: PrescriptionFile, index: number) => {
    if (!selectedAccountId || !detail || detailLoading || detailError) return
    const requestId = ++imageRequestRef.current
    setActionError('')
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
      setActionError('画像を取得できませんでした。再度お試しください。')
    }
  }, [detail, detailError, detailLoading, selectedAccountId])

  const moveViewer = useCallback((index: number) => {
    const file = readyFiles[index]
    if (file) void openImage(file, index)
  }, [openImage, readyFiles])

  const runAction = async (action: StatusAction) => {
    if (!selectedAccountId || !detail || actionLockRef.current || quoteLockRef.current || reviewLockRef.current || detailLoading || detailError || quoteRecovery) return
    if (shouldConfirmAction(action) && !window.confirm(actionConfirmationMessage(action))) return
    const selection = { ...selectionRef.current }
    const isCurrent = () => selectionRef.current.id === selection.id && selectionRef.current.version === selection.version
    actionLockRef.current = true
    setActing(true)
    setActionError('')
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
      if (!isCurrent()) return
      setActionMessage(actionNotice(result.notification.status))
      await Promise.all([openDetail(detail.submission.id), load()])
    } catch (caught) {
      if (!isCurrent()) return
      if (caught instanceof ApiError && caught.status === 409) {
        setActionError(prescriptionActionError(caught))
      } else {
        setActionError('状態更新の結果を確認できませんでした。最新状態を確認してから、操作をやり直してください。')
      }
      await Promise.all([openDetail(detail.submission.id), load()])
    } finally {
      actionLockRef.current = false
      setActing(false)
    }
  }

  const saveQuote = async () => {
    if (!selectedAccountId || !detail || quoteLockRef.current || actionLockRef.current || reviewLockRef.current || detailLoading || detailError || quoteRecovery) return
    const selection = { ...selectionRef.current }
    const isCurrent = () => selectionRef.current.id === selection.id && selectionRef.current.version === selection.version
    quoteLockRef.current = true
    setQuoteSaving(true)
    setActionError('')
    try {
      const result = await prescriptionAdminApi.saveFulfillmentQuote(
        selectedAccountId,
        detail.submission.id,
        {
          expectedRevision: quoteBaseRevisionRef.current,
          decision: quoteDraft.decision,
          reasonCodes: quoteDraft.reasonCodes,
          requirements: quoteDraft.requirements,
          estimatedReadyAt: quoteDraft.readyAt ? new Date(`${quoteDraft.readyAt}+09:00`).toISOString() : null,
          validUntil: quoteDraft.validUntil ? new Date(`${quoteDraft.validUntil}+09:00`).toISOString() : null,
          ...(quoteDraft.method ? { fulfillmentMethod: quoteDraft.method } : {}),
        },
      )
      if (!isCurrent()) return
      quoteDirtyRef.current = false
      quoteBaseRevisionRef.current = result.quote.revision
      setQuote(result.quote)
      setQuoteDraft(fulfillmentQuoteDraft(result.quote))
    } catch (caught) {
      if (!isCurrent()) return
      quoteDirtyRef.current = true
      setQuoteRecovery(caught instanceof ApiError && caught.status === 409
        ? '受付回答が変わりました。入力は保持しています。最新状態を確認し、入力を破棄してから編集し直してください。'
        : '受付回答の保存結果を確認できませんでした。入力は保持しています。最新状態を確認し、入力を破棄してから編集し直してください。')
      await openDetail(detail.submission.id)
    } finally {
      quoteLockRef.current = false
      setQuoteSaving(false)
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>
  const selectionVersion = selectionRef.current.version
  const detailUnavailable = detailLoading || Boolean(detailError)

  return (
    <div className="mx-auto max-w-7xl space-y-5 [&_fieldset]:min-w-0 [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:min-w-0 [&_select]:min-h-11 [&_select]:min-w-0 [&_a]:min-h-11 [&_a]:inline-flex [&_a]:items-center">
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

      {detailError && <div>
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{detailError}</p>
        <button type="button" onClick={() => void openDetail(selectionRef.current.id)} disabled={detailLoading} className="mt-2 min-h-11 rounded-lg border border-gray-300 px-4 text-sm">詳細を再読み込み</button>
      </div>}

      {detail && <fieldset disabled={detailUnavailable || acting || quoteSaving || reviewSaving}><PrescriptionReviewEditor
        key={detail.submission.id}
        accountId={selectedAccountId}
        submissionId={detail.submission.id}
        source={detail.source}
        validity={detail.validity}
        medicalSources={medicalSources}
        onSavingChange={(saving) => { reviewLockRef.current = saving; setReviewSaving(saving) }}
        onReload={() => openDetail(detail.submission.id)}
        onSaveSource={async (accountId, submissionId, body) => {
          const response = await pharmacyGrowthApi.classifySource(accountId, submissionId, body)
          if (!response.success) throw new Error(response.error)
        }}
        onSaveValidity={async (accountId, submissionId, body) => {
          const response = await pharmacyGrowthApi.saveValidity(accountId, submissionId, body)
          if (!response.success) throw new Error(response.error)
        }}
        onSaved={() => {
          if (selectionRef.current.id === detail.submission.id && selectionRef.current.version === selectionVersion) {
            void openDetail(detail.submission.id)
          }
        }}
      /></fieldset>}

      {quoteRecovery && <div>
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{quoteRecovery}</p>
        <button type="button" disabled={detailLoading || quoteSaving || acting || reviewSaving} onClick={() => {
          if (window.confirm('入力中の受付回答を破棄し、最新状態を読み込みますか？')) {
            void openDetail(selectionRef.current.id, true)
          }
        }} className="mt-2 rounded-lg border border-gray-300 px-4 py-2 text-sm">受付回答の入力を破棄して再読み込み</button>
      </div>}

      <PrescriptionDetailPanel
        detail={detail}
        loading={detailLoading}
        disabled={detailUnavailable || reviewSaving || Boolean(quoteRecovery)}
        readyFiles={readyFiles}
        quote={quote}
        quoteDraft={quoteDraft}
        quoteSaving={quoteSaving}
        acting={acting}
        actionMessage={actionMessage}
        actionError={actionError}
        reason={reason}
        onOpenImage={(file, index) => void openImage(file, index)}
        onQuoteChange={(draft) => { quoteDirtyRef.current = true; setQuoteDraft(draft) }}
        onQuoteSave={() => void saveQuote()}
        onReasonChange={setReason}
        onAction={(action) => void runAction(action)}
      />

      {viewer && <PrescriptionImageViewer imageUrl={viewer.url} position={viewer.index + 1} total={readyFiles.length} onClose={closeViewer} onPrevious={() => moveViewer(viewer.index - 1)} onNext={() => moveViewer(viewer.index + 1)} />}
    </div>
  )
}
