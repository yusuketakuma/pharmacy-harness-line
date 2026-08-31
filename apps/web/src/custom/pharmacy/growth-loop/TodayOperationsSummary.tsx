'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount } from '@/contexts/account-context'
import { PRESCRIPTION_STATUS_LABELS } from '@/custom/pharmacy/prescriptions/PrescriptionQueueOverview'
import { pharmacyGrowthApi, type PharmacyOperationsSummary } from './api'

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

export function createOperationsSummaryRequestGate() {
  let generation = 0
  return {
    start: () => ++generation,
    abort: () => { generation += 1 },
    isCurrent: (request: number) => generation === request,
  }
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

function formatUpdatedAt(value: string | null): string {
  if (!value) return '更新なし'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value))
}

export function TodayOperationsSummaryView({ summary }: { summary: OperationsSummary }) {
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
            {!summary.richMenu.error && <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{richMenuDisplayStatus(summary.richMenu)}</span>}
          </div>
          {summary.richMenu.error
            ? <p role="alert" className="mt-3 text-sm text-red-700">一部取得できません</p>
            : <p className="mt-3 text-sm text-gray-600">保存画像・catalog・公開状態を確認します。ここからLINEへの変更は行いません。</p>}
          <Link href="/rich-menus" className="mt-3 flex min-h-11 items-center text-sm font-medium text-green-700 hover:underline">設定画面を開く →</Link>
        </article>
      </div>
      <p className="text-xs text-gray-500">集計時刻: {formatUpdatedAt(summary.checkedAt)}</p>
    </section>
  )
}

export default function TodayOperationsSummary() {
  const { selectedAccountId } = useAccount()
  const [summary, setSummary] = useState<OperationsSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestGate = useRef(createOperationsSummaryRequestGate()).current

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    const request = requestGate.start()
    setLoading(true)
    setError('')
    try {
      const response = await pharmacyGrowthApi.operationsSummary(accountId)
      if (!requestGate.isCurrent(request)) return
      if (!response.success || !response.data || response.data.accountId !== accountId) {
        throw new Error('invalid account summary')
      }
      setSummary(response.data)
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
  return summary ? <TodayOperationsSummaryView summary={summary} /> : null
}
