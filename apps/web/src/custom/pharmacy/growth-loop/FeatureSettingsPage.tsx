'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { ApiError, api } from '@/lib/api'

const PATIENT_FEATURES = [
  { key: 'prescription_intake', label: '処方せん事前送信' },
  { key: 'electronic_prescription', label: '電子処方箋' },
  { key: 'emergency_contraception', label: '緊急避妊薬' },
  { key: 'pharmacy_info', label: '薬局情報' },
  { key: 'patient_intake', label: '患者アンケート' },
  { key: 'continuity', label: '継続フォロー' },
  { key: 'medication_followup', label: '服薬フォロー' },
  { key: 'manual_chat', label: '個別チャット' },
] as const

type PatientCapability = (typeof PATIENT_FEATURES)[number]['key']
type Config = NonNullable<Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.config>>, { success: true }>['data']>
type Readiness = Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.readiness>>, { success: true }>['data']
type ActiveWork = Extract<Awaited<ReturnType<typeof api.pharmacyGrowth.activeWork>>, { success: true }>['data']

export function setPatientCapability(
  capabilities: readonly string[], key: PatientCapability, enabled: boolean,
): string[] {
  return enabled ? [...new Set([...capabilities, key])] : capabilities.filter((value) => value !== key)
}

export default function FeatureSettingsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [config, setConfig] = useState<Config | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [activeWork, setActiveWork] = useState<ActiveWork | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    setLoading(true)
    setError('')
    try {
      const [response, readinessResponse, activeWorkResponse] = await Promise.all([
        api.pharmacyGrowth.config(accountId), api.pharmacyGrowth.readiness(accountId),
        api.pharmacyGrowth.activeWork(accountId),
      ])
      if (accountRef.current !== accountId) return
      if (!response.success || !response.data || !readinessResponse.success || !activeWorkResponse.success) {
        throw new Error('missing pharmacy feature state')
      }
      setConfig(response.data)
      setDraft(response.data.capabilities)
      setReadiness(readinessResponse.data)
      setActiveWork(activeWorkResponse.data)
    } catch {
      if (accountRef.current === accountId) setError('機能設定を取得できませんでした。')
    } finally {
      if (accountRef.current === accountId) setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    setConfig(null)
    setDraft([])
    setReadiness(null)
    setActiveWork(null)
    setMessage('')
    setError('')
    void load()
  }, [load])

  const enabledPatientFeatures = useMemo(() => PATIENT_FEATURES
    .filter(({ key }) => draft.includes(key)).map(({ key }) => key), [draft])
  const savedPatientFeatures = useMemo(() => PATIENT_FEATURES
    .filter(({ key }) => config?.capabilities.includes(key)).map(({ key }) => key), [config])
  const dirty = enabledPatientFeatures.join() !== savedPatientFeatures.join()

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function save() {
    if (!selectedAccountId || !config || saving || !dirty) return
    const disabled = savedPatientFeatures.filter((key) => !enabledPatientFeatures.includes(key))
    if (disabled.length > 0 && !window.confirm(
      `OFFにすると新しい受付を停止します。既存データは削除せず、対応中の案件は完了・取消まで操作できます。\n${disabled.map((key) => `${PATIENT_FEATURES.find((feature) => feature.key === key)?.label}: 対応中 ${activeWork?.[key] ?? 0}件`).join('\n')}\n保存しますか？`,
    )) return
    const accountId = selectedAccountId
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await api.pharmacyGrowth.saveConfig(accountId, {
        capabilities: enabledPatientFeatures,
        expectedRevision: config.revision,
        proactiveMonthlyLimit: config.proactive_monthly_limit,
      })
      if (accountRef.current !== accountId) return
      if (!response.success) throw new Error(response.error)
      setConfig(response.data)
      setDraft(response.data.capabilities)
      const [nextReadiness, nextActiveWork] = await Promise.all([
        api.pharmacyGrowth.readiness(accountId), api.pharmacyGrowth.activeWork(accountId),
      ])
      if (!nextReadiness.success || !nextActiveWork.success) throw new Error('missing pharmacy feature state')
      setReadiness(nextReadiness.data)
      setActiveWork(nextActiveWork.data)
      setMessage('機能設定を保存しました。')
    } catch (cause) {
      if (accountRef.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        setError('別の更新がありました。最新の設定を再取得しました。')
        await load()
      } else {
        setError('機能設定を保存できませんでした。owner権限を確認してください。')
      }
    } finally {
      if (accountRef.current === accountId) setSaving(false)
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div><h1 className="text-2xl font-bold text-gray-900">機能設定</h1><p className="mt-1 text-sm text-gray-600">患者向けLIFFに表示する機能を薬局ごとに設定します。</p></div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="patient-features-title">
        <h2 id="patient-features-title" className="font-semibold">患者向け機能</h2>
        <p className="mt-1 text-sm text-gray-600">全機能をOFFにもできます。OFF後も既存データは削除されず、対応中案件の完了・取消は継続できます。</p>
        {loading || !config ? <p className="py-8 text-center text-sm text-gray-500">設定を読み込み中...</p> : <div className="mt-4 divide-y divide-gray-200">{PATIENT_FEATURES.map(({ key, label }) => <label key={key} className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-3"><span><span className="block font-medium">{label}</span><span className="block text-xs text-gray-500">対応中 {activeWork?.[key] ?? 0}件</span></span><input type="checkbox" checked={draft.includes(key)} onChange={(event) => setDraft((current) => setPatientCapability(current, key, event.target.checked))} disabled={saving} className="h-5 w-5" /></label>)}</div>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-amber-700">{dirty ? '未保存の変更があります。' : '保存済みです。'}</p><button type="button" onClick={() => void save()} disabled={!dirty || saving || loading} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '設定を保存'}</button></div>
      </section>
      {readiness && <section className="grid gap-4 sm:grid-cols-2" aria-label="機能 readiness">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold">電子処方箋 readiness</h2>
          <p className="mt-2 text-sm font-bold">{readiness.electronicPrescription.status}</p>
          <p className="mt-2 text-sm text-gray-600">Endpoint設定: {readiness.electronicPrescription.endpointConfigured ? 'あり' : 'なし'}</p>
          <p className="text-sm text-gray-600">外部確認: {readiness.electronicPrescription.endpointEvidence.status}</p>
          <p className="mt-2 text-xs text-gray-500">設定済みでも、LINE Developers Consoleでの確認証拠がない場合はUNVERIFIEDです。</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold">緊急避妊薬 readiness</h2>
          <p className="mt-2 text-sm font-bold">{readiness.emergencyContraception.status}</p>
          <ul className="mt-2 space-y-1 text-sm text-gray-600">
            <li>研修修了薬剤師: {readiness.emergencyContraception.trainedPharmacistAvailable ? 'あり' : 'なし'}</li>
            <li>在庫: {readiness.emergencyContraception.inventoryAvailable ? 'あり' : 'なし'}</li>
            <li>将来の受付枠: {readiness.emergencyContraception.futureSlotAvailable ? 'あり' : 'なし'}</li>
          </ul>
        </div>
      </section>}
    </div>
  )
}
