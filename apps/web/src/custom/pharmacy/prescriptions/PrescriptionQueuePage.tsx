'use client'

import Link from 'next/link'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { ApiError } from '../../../lib/api'
import {
  prescriptionAdminApi,
  type PrescriptionAdminAction,
  type PrescriptionDetail,
  type PrescriptionFile,
  type PrescriptionQueueItem,
  type PrescriptionStats,
  type PrescriptionStatus,
} from './api'

const STATUS_LABELS: Record<PrescriptionStatus, string> = {
  draft: '下書き',
  received: '受付待ち',
  needs_resubmission: '再送依頼中',
  accepted: '受付済み',
  ready: '準備完了',
  closed: '完了',
  cancelled: 'キャンセル',
}

const REASON_LABELS: Record<string, string> = {
  blurred: '画像がぼやけています',
  cropped: '処方せんの一部が切れています',
  glare: '光が反射しています',
  unreadable: '文字を読み取れません',
  missing_page: '不足しているページがあります',
  admin_cancelled: '薬局でキャンセルしました',
}

export const statusLabel = (status: PrescriptionStatus) => STATUS_LABELS[status]
export const reasonLabel = (reason: string | null) => reason ? REASON_LABELS[reason] ?? reason : 'なし'

export interface StatusAction {
  id: PrescriptionAdminAction
  label: string
  danger?: boolean
}

export function actionsForStatus(status: PrescriptionStatus): StatusAction[] {
  if (status === 'received') return [
    { id: 'accept', label: '受付する' },
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

export function isTemporaryDeploymentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'status' in error && (error.status === 404 || error.status === 503)
}

const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '指定なし'

function waitingAge(value: string | null): string {
  if (!value) return '待機なし'
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}時間` : `${Math.floor(hours / 24)}日`
}

export function PrescriptionQueueEmptyState({ temporaryError = false }: { temporaryError?: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
      <p className="font-medium text-gray-800">
        {temporaryError ? '処方せん機能を準備中です' : '処方せんはありません'}
      </p>
      {temporaryError && <p className="mt-2 text-sm text-gray-500">少し待ってから再読み込みしてください。</p>}
    </div>
  )
}

export function PrescriptionImageViewer({
  imageUrl,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  imageUrl: string
  position: number
  total: number
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrevious()
      if (event.key === 'ArrowRight') onNext()
      if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(3, value + 0.25))
      if (event.key === '-') setZoom((value) => Math.max(0.5, value - 0.25))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, onNext, onPrevious])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3" role="dialog" aria-modal="true" aria-label="処方せん画像">
      <div className="flex flex-wrap items-center justify-center gap-2 text-white">
        <button type="button" onClick={onPrevious} disabled={position <= 1} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">前の画像</button>
        <span aria-live="polite">{position} / {total}</span>
        <button type="button" onClick={onNext} disabled={position >= total} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">次の画像</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className="rounded bg-white/15 px-3 py-2">拡大</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} className="rounded bg-white/15 px-3 py-2">縮小</button>
        <button type="button" onClick={() => setRotation((value) => value - 90)} className="rounded bg-white/15 px-3 py-2">左回転</button>
        <button type="button" onClick={() => setRotation((value) => value + 90)} className="rounded bg-white/15 px-3 py-2">右回転</button>
        <button type="button" onClick={onClose} className="rounded bg-white px-3 py-2 text-black">閉じる</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, short-lived blob URL */}
        <img
          src={imageUrl}
          alt={`処方せん画像 ${position}`}
          className="max-h-full max-w-full object-contain transition-transform"
          style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
    </div>
  )
}

const TABS: Array<{ value: 'all' | PrescriptionStatus; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'received', label: '受付待ち' },
  { value: 'accepted', label: '受付済み' },
  { value: 'needs_resubmission', label: '再送依頼中' },
  { value: 'ready', label: '準備完了' },
  { value: 'closed', label: '完了' },
  { value: 'cancelled', label: 'キャンセル' },
]

export default function PrescriptionQueuePage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<PrescriptionQueueItem[]>([])
  const [stats, setStats] = useState<PrescriptionStats>({ pending_count: 0, oldest_wait_at: null })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [tab, setTab] = useState<'all' | PrescriptionStatus>('received')
  const [loading, setLoading] = useState(false)
  const [temporaryError, setTemporaryError] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [acting, setActing] = useState(false)
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
    void load()
  }, [load, selectedAccountId])

  const openDetail = useCallback(async (id: string) => {
    if (!selectedAccountId) return
    setDetailLoading(true)
    setError('')
    try {
      setDetail(await prescriptionAdminApi.detail(selectedAccountId, id))
      setTemporaryError(false)
    } catch (caught) {
      setTemporaryError(isTemporaryDeploymentError(caught))
      setError(isTemporaryDeploymentError(caught) ? '' : '処方せん詳細を取得できませんでした。')
    } finally {
      setDetailLoading(false)
    }
  }, [selectedAccountId])

  const visibleItems = useMemo(
    () => tab === 'all' ? items : items.filter((item) => item.status === tab),
    [items, tab],
  )
  const counts = useMemo(() => items.reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1
    return result
  }, { all: items.length }), [items])

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
    if (!window.confirm(`「${action.label}」を実行しますか？`)) return
    setActing(true)
    setError('')
    try {
      await prescriptionAdminApi.action(
        selectedAccountId,
        detail.submission.id,
        action.id,
        detail.submission.updated_at,
        action.id === 'request_resubmission' ? reason : undefined,
      )
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

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">処方せん事前送信</h1>
          <p className="mt-1 text-sm text-gray-500">患者さんから届いた画像を確認し、受付状況を更新します。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">受付待ち</p>
          <p className="mt-1 text-2xl font-bold">{stats.pending_count}件</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">最長待ち時間</p>
          <p className="mt-1 text-2xl font-bold">{waitingAge(stats.oldest_wait_at)}</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="処方せんの状態">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            onClick={() => setTab(item.value)}
            className={`whitespace-nowrap rounded-full px-3 py-2 text-sm ${tab === item.value ? 'bg-green-600 text-white' : 'bg-white text-gray-700 ring-1 ring-gray-200'}`}
          >
            {item.label} {counts[item.value] ?? 0}
          </button>
        ))}
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {temporaryError ? <PrescriptionQueueEmptyState temporaryError /> : visibleItems.length === 0 && !loading ? <PrescriptionQueueEmptyState /> : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-200">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void openDetail(item.id)} className="grid w-full gap-2 p-4 text-left hover:bg-gray-50 sm:grid-cols-4 sm:items-center">
                  <span className="font-medium text-gray-900">{statusLabel(item.status)}</span>
                  <span className="text-sm text-gray-600">受付: {formatDate(item.requested_at ?? item.created_at)}</span>
                  <span className="text-sm text-gray-600">受取希望: {formatDate(item.desired_pickup_at)}</span>
                  <span className="text-sm text-green-700 sm:text-right">詳細を見る</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {nextCursor && <button type="button" onClick={() => void load(nextCursor)} disabled={loading} className="w-full rounded-lg border border-gray-300 bg-white py-2 text-sm disabled:opacity-50">さらに読み込む</button>}

      {(detail || detailLoading) && (
        <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="prescription-detail-title">
          {detailLoading && !detail ? <p>詳細を読み込み中...</p> : detail && (
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
                    <button key={file.id} type="button" onClick={() => void openImage(file, index)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">画像 {file.position} を表示</button>
                  ))}
                  {readyFiles.length === 0 && <p className="text-sm text-gray-500">表示できる画像はありません。</p>}
                </div>
              </div>

              {actionsForStatus(detail.submission.status).some((action) => action.id === 'request_resubmission') && (
                <label className="block max-w-md text-sm font-medium text-gray-700">
                  再送理由
                  <select value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
                    {Object.entries(REASON_LABELS).filter(([key]) => key !== 'admin_cancelled').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
              )}

              <div className="flex flex-wrap gap-2">
                {actionsForStatus(detail.submission.status).map((action) => (
                  <button key={action.id} type="button" onClick={() => void runAction(action)} disabled={acting} className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${action.danger ? 'bg-red-600' : 'bg-green-600'}`}>{action.label}</button>
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
      )}

      {viewer && <PrescriptionImageViewer imageUrl={viewer.url} position={viewer.index + 1} total={readyFiles.length} onClose={closeViewer} onPrevious={() => moveViewer(viewer.index - 1)} onNext={() => moveViewer(viewer.index + 1)} />}
    </div>
  )
}
