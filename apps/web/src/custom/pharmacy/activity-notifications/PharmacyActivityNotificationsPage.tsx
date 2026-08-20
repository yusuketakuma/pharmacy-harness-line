'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { isTemporaryDeploymentError } from '../prescriptions/PrescriptionQueueOverview'
import {
  activityTypeLabel,
  pharmacyActivityApi,
  type PharmacyActivityNotification,
} from './api'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value))
}

export function activityAcknowledgementMessage(): string {
  return '確認済みにすると、この通知は一覧から消えます。この画面からは戻せません。よろしいですか？'
}

export default function PharmacyActivityNotificationsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<PharmacyActivityNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const acknowledgedIds = useRef(new Set<string>())

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true)
    try {
      const result = await pharmacyActivityApi.list(selectedAccountId)
      setItems(result.notifications.filter((item) => !acknowledgedIds.current.has(item.id)))
      setLoadError('')
    } catch (caught) {
      setLoadError(isTemporaryDeploymentError(caught) ? '通知機能を準備中です。' : '通知を取得できませんでした。')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = window.setInterval(() => { void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const acknowledge = async (item: PharmacyActivityNotification) => {
    if (!selectedAccountId || acknowledgingId !== null) return
    if (!window.confirm(activityAcknowledgementMessage())) return
    setAcknowledgingId(item.id)
    setActionError('')
    try {
      await pharmacyActivityApi.acknowledge(selectedAccountId, item.id)
      acknowledgedIds.current.add(item.id)
      setItems((current) => current.filter((candidate) => candidate.id !== item.id))
    } catch {
      setActionError('通知の状態を更新できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      setAcknowledgingId(null)
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <main className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">薬局の動き</h1>
          <p className="mt-1 text-sm text-gray-500">処方せん受付や確認の変化を、患者情報を含めずに表示します。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
      </div>
      {(loadError || actionError) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError || loadError}</p>}
      {loading && items.length === 0
        ? <p className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">通知を読み込み中...</p>
        : loadError && items.length === 0
          ? <p className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-700">通知を表示できません。再読み込みしてください。</p>
          : items.length === 0
            ? <p className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">未確認の動きはありません。</p>
        : <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <div>
                <p className="font-medium text-gray-900">{activityTypeLabel[item.activity_type]}</p>
                <p className="mt-1 text-sm text-gray-500">{formatDate(item.created_at)}</p>
                <p className="mt-1 font-mono text-xs text-gray-500">通知ID: {item.id.slice(0, 8)}</p>
              </div>
              <button type="button" onClick={() => void acknowledge(item)} disabled={acknowledgingId !== null} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{acknowledgingId === item.id ? '更新中…' : '確認済みにする'}</button>
            </li>
          ))}
        </ul>}
    </main>
  )
}
