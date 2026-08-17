'use client'

import React from 'react'
import type {
  PrescriptionQueueItem,
  PrescriptionStats,
  PrescriptionStatus,
} from './api'

const STATUS_LABELS: Record<PrescriptionStatus, string> = {
  draft: '下書き',
  received: '受付内容の確認待ち',
  needs_resubmission: '再送依頼中',
  accepted: '受付済み',
  ready: '準備完了',
  closed: '完了',
  cancelled: 'キャンセル',
}

export type PrescriptionQueueTab = 'all' | PrescriptionStatus

const TABS: Array<{ value: PrescriptionQueueTab; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'received', label: '受付内容の確認待ち' },
  { value: 'accepted', label: '受付済み' },
  { value: 'needs_resubmission', label: '再送依頼中' },
  { value: 'ready', label: '準備完了' },
  { value: 'closed', label: '完了' },
  { value: 'cancelled', label: 'キャンセル' },
]

export const statusLabel = (status: PrescriptionStatus) => STATUS_LABELS[status]

export function isTemporaryDeploymentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'status' in error && (error.status === 404 || error.status === 503)
}

export const formatDate = (value: string | null) => value
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

export function PrescriptionQueueOverview({
  items,
  stats,
  tab,
  loading,
  temporaryError,
  error,
  nextCursor,
  onTabChange,
  onOpenDetail,
  onLoadMore,
}: {
  items: PrescriptionQueueItem[]
  stats: PrescriptionStats
  tab: PrescriptionQueueTab
  loading: boolean
  temporaryError: boolean
  error: string
  nextCursor: string | null
  onTabChange: (tab: PrescriptionQueueTab) => void
  onOpenDetail: (id: string) => void
  onLoadMore: (cursor: string) => void
}) {
  const visibleItems = tab === 'all' ? items : items.filter((item) => item.status === tab)
  const counts = items.reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1
    return result
  }, { all: items.length })

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">受付内容の確認待ち</p>
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
            onClick={() => onTabChange(item.value)}
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
                <button type="button" onClick={() => onOpenDetail(item.id)} className="grid w-full gap-2 p-4 text-left hover:bg-gray-50 sm:grid-cols-4 sm:items-center">
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
      {nextCursor && <button type="button" onClick={() => onLoadMore(nextCursor)} disabled={loading} className="w-full rounded-lg border border-gray-300 bg-white py-2 text-sm disabled:opacity-50">さらに読み込む</button>}
    </>
  )
}
