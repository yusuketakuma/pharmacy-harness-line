'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount } from '@/contexts/account-context'
import { PRESCRIPTION_STATUS_LABELS } from '@/custom/pharmacy/prescriptions/PrescriptionQueueOverview'
import { createRequestGate as createOperationsSummaryRequestGate } from '../request-gate'
import { pharmacyGrowthApi, type PharmacyActionQueue, type PharmacyOperationsSummary } from './api'
import { readinessStatusLabel } from './readiness-labels'

export { createOperationsSummaryRequestGate }

export type OperationsSummary = PharmacyOperationsSummary
type DomainKey = keyof OperationsSummary['domains']

const DOMAIN_META: Array<{ key: DomainKey; label: string; href: string }> = [
  { key: 'prescriptionIntake', label: '処方せん受付', href: '/prescriptions' },
  { key: 'electronicPrescription', label: '電子処方箋受付', href: '/myna' },
  { key: 'patientIntake', label: '患者アンケート', href: '/patient-intakes' },
  { key: 'continuity', label: '継続フォロー', href: '/continuity' },
  { key: 'medicationFollowup', label: '服薬フォロー', href: '/patient-intakes?followup=attention' },
  { key: 'emergencyContraception', label: '緊急避妊薬', href: '/emergency-contraception' },
]

const STATUS_LABELS: Record<string, string> = {
  ...PRESCRIPTION_STATUS_LABELS,
  CREATED: '受付開始', LAUNCH_REQUESTED: '外部受付を開いた',
  PATIENT_REPORTED_COMPLETE: '患者操作完了', PATIENT_REPORTED_NO_PRESCRIPTION: '処方せんなし申告',
  SUPPORT_NEEDED: '操作支援', unreviewed: '未確認', offered: '患者回答待ち',
  active: '送信処理中', reminded: 'お知らせ済み', paused: '一時停止',
  scheduled: '送信予約', due: '送信処理中', delivered: '回答待ち', concern: '要確認',
  pharmacist_requested: '薬剤師相談', assigned: '担当中', responded: '対応済み', escalated: '優先確認',
  provisional: '仮受付', reviewed: '確認済み',
}

const ACTION_DOMAIN_LABELS: Record<PharmacyActionQueue['items'][number]['domain'], string> = {
  prescriptionIntake: '処方せん受付',
  electronicPrescription: '電子処方箋受付',
  patientIntake: '患者アンケート',
  continuity: '継続フォロー',
  medicationFollowup: '服薬フォロー',
  emergencyContraception: '緊急避妊薬',
  manualChat: '個別チャット',
}

const ACTION_DEADLINE_LABELS: Record<PharmacyActionQueue['items'][number]['deadline'], string> = {
  overdue: '期限超過', today: '本日', upcoming: '今後', none: '期限なし',
}

export function richMenuDisplayStatus(richMenu: OperationsSummary['richMenu']): 'OFF' | 'STALE' | 'READY' | 'BLOCKED' | 'UNVERIFIED' {
  if (richMenu.capabilityEnabled === false) return 'OFF'
  if (richMenu.savedVersionAvailable && richMenu.catalogVersionCurrent === false) return 'STALE'
  return richMenu.status ?? 'UNVERIFIED'
}

function featureState(domain: OperationsSummary['domains'][DomainKey]): string {
  if (domain.enabled === null) return '設定不明'
  if (domain.enabled) return 'ON'
  return domain.activeCount ? 'OFF（利用中）' : 'OFF'
}

const UPDATED_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short',
})

function formatUpdatedAt(value: string | null): string {
  if (!value) return '更新なし'
  return UPDATED_AT_FORMAT.format(new Date(value))
}

export function TodayOperationsSummaryView({
  summary,
  actionQueue,
  actionQueueError = '',
}: {
  summary: OperationsSummary
  actionQueue?: PharmacyActionQueue | null
  actionQueueError?: string
}) {
  return (
    <section className="mx-auto max-w-6xl space-y-4 p-6 pb-0" aria-labelledby="today-operations-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="today-operations-title" className="text-2xl font-bold text-gray-900">本日の対応</h1>
          <p className="mt-1 text-sm text-gray-600">患者情報を表示せず、選択中の薬局アカウントの対応件数だけをまとめています。</p>
        </div>
        <Link href="/pharmacy-features" className="flex min-h-11 items-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">機能設定</Link>
      </div>
      {summary.capabilityError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">機能のON/OFFを取得できませんでした。件数は取得できた範囲で表示します。</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {DOMAIN_META.map(({ key, label, href }) => {
          const domain = summary.domains[key]
          return <article key={key} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold text-gray-900">{label}</h2>
              <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{featureState(domain)}</span>
            </div>
            {domain.error ? <p role="alert" className="mt-3 text-sm text-red-700">一部取得できません</p> : <>
              <p className="mt-3 text-3xl font-bold text-gray-900">{domain.activeCount}<span className="ml-1 text-sm font-normal text-gray-500">件</span></p>
              <ul className="mt-2 flex flex-wrap gap-2 text-xs text-gray-600">
                {Object.entries(domain.statusCounts).map(([status, count]) => <li key={status} className="rounded bg-gray-50 px-2 py-1">{STATUS_LABELS[status] ?? status}: {count}</li>)}
              </ul>
              <p className="mt-3 text-xs text-gray-500">最終更新: {formatUpdatedAt(domain.updatedAt)}</p>
            </>}
            <Link href={href} className="mt-3 flex min-h-11 items-center text-sm font-medium text-green-700 hover:underline">対象画面を開く →</Link>
          </article>
        })}
        <article className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-semibold text-gray-900">リッチメニュー</h2>
            {!summary.richMenu.error && <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{readinessStatusLabel(richMenuDisplayStatus(summary.richMenu))}</span>}
          </div>
          {summary.richMenu.error
            ? <p role="alert" className="mt-3 text-sm text-red-700">一部取得できません</p>
            : <p className="mt-3 text-sm text-gray-600">保存画像・catalog・公開状態を確認します。ここからLINEへの変更は行いません。</p>}
          <Link href="/rich-menus" className="mt-3 flex min-h-11 items-center text-sm font-medium text-green-700 hover:underline">設定画面を開く →</Link>
        </article>
      </div>
      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="action-queue-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="action-queue-title" className="font-semibold text-gray-900">対応が必要な項目</h2>
            <p className="mt-1 text-sm text-gray-600">既存の記録を確認するための読み取り専用一覧です。ここから状態変更や一括操作は行いません。</p>
          </div>
          {actionQueue?.truncated && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">先頭50件を表示</span>}
        </div>
        {actionQueueError
          ? <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">対応一覧を取得できませんでした。各機能の画面から確認してください。</p>
          : actionQueue?.partial && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">一部の機能を取得できませんでした。表示できた範囲だけを示しています。</p>}
        {actionQueue && actionQueue.items.length === 0
          ? <p className="mt-3 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">対応が必要な項目はありません。</p>
          : actionQueue && <ol className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
            {actionQueue.items.map((item, index) => <li key={`${item.domain}-${item.status}-${index}`}>
              <Link href={item.detailHref} className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm hover:bg-gray-50">
                <span className="font-medium text-gray-900">{ACTION_DOMAIN_LABELS[item.domain]}</span>
                <span className="text-gray-600">{STATUS_LABELS[item.status] ?? item.status}</span>
                <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{ACTION_DEADLINE_LABELS[item.deadline]}</span>
                <span className="font-medium text-green-700">確認画面へ →</span>
              </Link>
            </li>)}
          </ol>}
      </section>
      <p className="text-xs text-gray-500">集計時刻: {formatUpdatedAt(summary.checkedAt)}</p>
    </section>
  )
}

export default function TodayOperationsSummary() {
  const { selectedAccountId } = useAccount()
  const [summary, setSummary] = useState<OperationsSummary | null>(null)
  const [actionQueue, setActionQueue] = useState<PharmacyActionQueue | null>(null)
  const [actionQueueError, setActionQueueError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestGate = useRef(createOperationsSummaryRequestGate()).current

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    const request = requestGate.start()
    setLoading(true)
    setError('')
    setActionQueue(null)
    setActionQueueError('')
    try {
      const [summaryResult, queueResult] = await Promise.allSettled([
        pharmacyGrowthApi.operationsSummary(accountId),
        pharmacyGrowthApi.actionQueue(accountId),
      ])
      if (!requestGate.isCurrent(request)) return
      if (queueResult.status === 'fulfilled' && queueResult.value.success && queueResult.value.data && queueResult.value.data.accountId === accountId) {
        setActionQueue(queueResult.value.data)
      } else {
        setActionQueueError('対応一覧を取得できませんでした。')
      }
      if (summaryResult.status === 'rejected' || !summaryResult.value.success || !summaryResult.value.data || summaryResult.value.data.accountId !== accountId) {
        throw new Error('invalid account summary')
      }
      setSummary(summaryResult.value.data)
    } catch {
      if (requestGate.isCurrent(request)) setError('本日の対応を取得できませんでした。')
    } finally {
      if (requestGate.isCurrent(request)) setLoading(false)
    }
  }, [requestGate, selectedAccountId])

  useEffect(() => {
    requestGate.abort()
    setSummary(null)
    setError('')
    void load()
    return () => requestGate.abort()
  }, [load, requestGate])

  if (loading && !summary) return <p role="status" className="px-6 py-8 text-center text-sm text-gray-500">本日の対応を読み込み中...</p>
  if (error) return <div className="mx-auto max-w-6xl p-6 pb-0"><p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium">再試行</button></div>
  return summary ? <TodayOperationsSummaryView summary={summary} actionQueue={actionQueue} actionQueueError={actionQueueError} /> : null
}
