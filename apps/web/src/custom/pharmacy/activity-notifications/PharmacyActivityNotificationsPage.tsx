'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { isTemporaryDeploymentError } from '../prescriptions/PrescriptionQueueOverview'
import {
  activityTypeLabel,
  pharmacyActivityApi,
  type PharmacyActivityNotification,
} from './api'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value))
}

export default function PharmacyActivityNotificationsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<PharmacyActivityNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true)
    try {
      const result = await pharmacyActivityApi.list(selectedAccountId)
      setItems(result.notifications)
      setError('')
    } catch (caught) {
      setError(isTemporaryDeploymentError(caught) ? '通知機能を準備中です。' : '通知を取得できませんでした。')
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
    if (!selectedAccountId) return
    try {
      if (item.status === 'unread') await pharmacyActivityApi.claim(selectedAccountId, item.id)
      await pharmacyActivityApi.acknowledge(selectedAccountId, item.id)
      setItems((current) => current.filter((candidate) => candidate.id !== item.id))
    } catch {
      setError('通知の状態を更新できませんでした。')
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
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {items.length === 0 && !loading
        ? <p className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">未確認の動きはありません。</p>
        : <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <div>
                <p className="font-medium text-gray-900">{activityTypeLabel[item.activity_type]}</p>
                <p className="mt-1 text-sm text-gray-500">{formatDate(item.created_at)}</p>
              </div>
              <button type="button" onClick={() => void acknowledge(item)} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">確認済みにする</button>
            </li>
          ))}
        </ul>}
    </main>
  )
}
