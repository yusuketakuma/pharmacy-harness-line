'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount } from '@/contexts/account-context'
import { ApiError, api, type PharmacyRichMenuCandidate } from '@/lib/api'
import { richMenuAreaStyle } from '@/custom/pharmacy/rich-menu/preview-geometry'

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

const READINESS_STATUS_LABELS: Record<string, string> = {
  READY: '準備完了', BLOCKED: '要対応', CURRENT: '一致', STALE: '未反映', UNVERIFIED: '未確認',
  VERIFIED: '確認済み', MISSING: '未設定',
}

export function readinessStatusLabel(status: string): string {
  return READINESS_STATUS_LABELS[status] ?? status
}

const REASON_CODE_LABELS: Record<string, string> = {
  ACCOUNT_INACTIVE: 'LINEアカウントが無効です',
  TENANT_INACTIVE: 'テナントが無効です',
  TENANT_MAPPING_MISSING: 'テナントとの紐付けがありません',
  BOT_IDENTITY_MISSING: 'LINE公式アカウント情報が未取得です',
  CAPABILITY_CONFIG_MISSING: '機能設定が未作成です',
  LIFF_ID_MISSING: 'LIFF IDが未設定です',
  LIFF_ENDPOINT_UNVERIFIED: 'LIFFエンドポイントが未確認です',
  LIFF_PUBLIC_ORIGIN_INVALID: 'LIFF公開URLが不正です',
  LINE_CREDENTIAL_UNVERIFIED: 'LINE接続が未確認です',
  LOGIN_CHANNEL_MISSING: 'LINEログインチャネルが未設定です',
  LOGIN_CREDENTIAL_MISSING: 'LINEログインの認証情報が未設定です',
  MESSAGING_CREDENTIAL_MISSING: 'メッセージ配信の認証情報が未設定です',
  STAFF_ASSIGNMENT_MISSING: '担当スタッフが未割当です',
  READINESS_UNAVAILABLE: '準備状態を取得できません',
}

export function reasonCodeLabel(code: string): string {
  return REASON_CODE_LABELS[code] ?? '確認が必要です'
}

export function shouldOfferRichMenuCandidate(capabilities: readonly string[]): boolean {
  return capabilities.includes('pharmacy_rich_menu')
}

type CandidateChange = Extract<PharmacyRichMenuCandidate, { syncStatus: 'CURRENT' | 'STALE' }>['changes'][number]

export function pharmacyCandidateChangeLabel(change: CandidateChange): string {
  if (change.kind === 'removed') {
    return `公開中の枠${(change.currentIndex ?? 0) + 1}を候補から削除します。OFFにした機能の画像とtap actionが公開中に残っています。`
  }
  if (change.kind === 'added') {
    return `候補の枠${(change.draftIndex ?? 0) + 1}を追加します。ONにした機能は公開中メニューへまだ反映されていません。`
  }
  if (change.kind === 'moved') {
    return `公開中の枠${(change.currentIndex ?? 0) + 1}を候補の枠${(change.draftIndex ?? 0) + 1}へ移動します。`
  }
  const slot = (change.draftIndex ?? change.currentIndex ?? 0) + 1
  if (change.kind === 'action_changed') return `枠${slot}のtap actionを変更します。`
  if (change.kind === 'image_changed') return `枠${slot}の画像を変更します。`
  return `枠${slot}は公開中と同一です。`
}

export default function FeatureSettingsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [config, setConfig] = useState<Config | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [monthlyLimit, setMonthlyLimit] = useState(0)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [activeWork, setActiveWork] = useState<ActiveWork | null>(null)
  const [candidate, setCandidate] = useState<PharmacyRichMenuCandidate | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
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
      setMonthlyLimit(response.data.proactive_monthly_limit)
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
    setMonthlyLimit(0)
    setReadiness(null)
    setActiveWork(null)
    setCandidate(null)
    setCandidateLoading(false)
    setMessage('')
    setError('')
    void load()
  }, [load])

  const enabledPatientFeatures = useMemo(() => PATIENT_FEATURES
    .filter(({ key }) => draft.includes(key)).map(({ key }) => key), [draft])
  const savedPatientFeatures = useMemo(() => PATIENT_FEATURES
    .filter(({ key }) => config?.capabilities.includes(key)).map(({ key }) => key), [config])
  const monthlyLimitValid = Number.isInteger(monthlyLimit) && monthlyLimit >= 0 && monthlyLimit <= 100
  const dirty = enabledPatientFeatures.join() !== savedPatientFeatures.join() ||
    monthlyLimit !== config?.proactive_monthly_limit

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function save() {
    if (!selectedAccountId || !config || saving || !dirty || !monthlyLimitValid) return
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
        proactiveMonthlyLimit: monthlyLimit,
      })
      if (accountRef.current !== accountId) return
      if (!response.success) throw new Error(response.error)
      setConfig(response.data)
      setDraft(response.data.capabilities)
      setMonthlyLimit(response.data.proactive_monthly_limit)
      setCandidate(null)
      setMessage(shouldOfferRichMenuCandidate(response.data.capabilities)
        ? '機能設定を保存しました。リッチメニュー候補画像を確認してください。'
        : '機能設定を保存しました。')
      try {
        const [nextReadiness, nextActiveWork] = await Promise.all([
          api.pharmacyGrowth.readiness(accountId), api.pharmacyGrowth.activeWork(accountId),
        ])
        if (!nextReadiness.success || !nextActiveWork.success) throw new Error('missing pharmacy feature state')
        if (accountRef.current !== accountId) return
        setReadiness(nextReadiness.data)
        setActiveWork(nextActiveWork.data)
      } catch {
        if (accountRef.current === accountId) {
          setError('機能設定は保存しましたが、最新の設定診断を取得できませんでした。再読み込みしてください。')
        }
      }
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

  async function previewRichMenuCandidate() {
    if (!selectedAccountId || candidateLoading) return
    const accountId = selectedAccountId
    setCandidateLoading(true)
    setError('')
    try {
      const response = await api.richMenuGroups.pharmacyCandidate(accountId)
      if (accountRef.current !== accountId) return
      if (!response.success || response.data.accountId !== accountId) {
        throw new Error('candidate scope mismatch')
      }
      setCandidate(response.data)
    } catch {
      if (accountRef.current === accountId) {
        setError('リッチメニュー候補画像を確認できませんでした。catalogとLIFF設定を確認してください。')
      }
    } finally {
      if (accountRef.current === accountId) setCandidateLoading(false)
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
        {loading || !config ? <p className="py-8 text-center text-sm text-gray-500">設定を読み込み中...</p> : <><div className="mt-4 divide-y divide-gray-200">{PATIENT_FEATURES.map(({ key, label }) => <label key={key} className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-3"><span><span className="block font-medium">{label}</span><span className="block text-xs text-gray-500">対応中 {activeWork?.[key] ?? 0}件</span></span><input type="checkbox" checked={draft.includes(key)} onChange={(event) => setDraft((current) => setPatientCapability(current, key, event.target.checked))} disabled={saving} className="h-5 w-5" /></label>)}</div><label className="mt-4 block max-w-xs text-sm font-medium">月間自動通知上限
          <input type="number" min={0} max={100} step={1} value={monthlyLimit} onChange={(event) => setMonthlyLimit(Number(event.target.value))} disabled={saving} aria-describedby="monthly-limit-help" className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" />
          <span id="monthly-limit-help" className="mt-1 block text-xs font-normal text-gray-500">薬局から自動送信する中立通知の月間上限です。0で自動通知を停止します。</span>
        </label></>}
        {!monthlyLimitValid && <p role="alert" className="mt-2 text-sm text-red-700">月間自動通知上限は0〜100の整数で入力してください。</p>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-amber-700">{dirty ? '未保存の変更があります。' : '保存済みです。'}</p><button type="button" onClick={() => void save()} disabled={!dirty || !monthlyLimitValid || saving || loading} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '設定を保存'}</button></div>
      </section>
      {shouldOfferRichMenuCandidate(config?.capabilities ?? []) && <section className="rounded-xl border border-violet-200 bg-white p-5" aria-labelledby="rich-menu-candidate-title">
        <h2 id="rich-menu-candidate-title" className="font-semibold">リッチメニュー候補</h2>
        <p className="mt-1 text-sm text-gray-600">機能ON/OFF後の保存済みJPEGとtap actionです。確認だけではLINE表示を変更しません。</p>
        <p className="mt-1 text-xs text-gray-500">電子処方箋・緊急避妊薬などは「すべての機能」から開けます。</p>
        <button type="button" onClick={() => void previewRichMenuCandidate()} disabled={candidateLoading} className="mt-3 min-h-11 rounded-lg border border-violet-600 px-4 py-2 text-sm font-medium text-violet-800 disabled:opacity-50">{candidateLoading ? '確認中…' : 'リッチメニュー候補画像を確認'}</button>
        {candidate && <div aria-live="polite" className="mt-4 rounded-lg bg-violet-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">同期状態: {readinessStatusLabel(candidate.syncStatus)}</p>
            <p className="text-xs text-gray-600">{candidate.menuSize === 'large' ? '2500×1686' : '2500×843'} / {candidate.catalogVersion} / {candidate.variantKey}</p>
          </div>
          {candidate.syncStatus === 'UNVERIFIED'
            ? <p className="mt-2 text-sm text-amber-800">LINEの現在表示を確認できないため、自動反映せず候補だけを表示しています。</p>
            : candidate.syncStatus === 'CURRENT'
              ? <p className="mt-2 text-sm text-green-800">公開中メニューと同一です。</p>
              : <ul className="mt-2 space-y-1 text-sm text-violet-950">{candidate.changes.filter((change) => change.kind !== 'same').map((change, index) => <li key={`${change.kind}-${change.currentIndex}-${change.draftIndex}-${index}`}>{pharmacyCandidateChangeLabel(change)}</li>)}</ul>}
          <div className="relative mt-4 overflow-hidden rounded border border-violet-300 bg-gray-100" style={{ aspectRatio: candidate.menuSize === 'large' ? '2500 / 1686' : '2500 / 843' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.richMenuGroups.pharmacyCandidateImageUrl(candidate.accountId, candidate)} alt="機能設定から導出したリッチメニュー候補画像" className="absolute inset-0 h-full w-full object-cover" />
            {candidate.slots.map((slot, index) => <span key={slot.actionKey} role="img" tabIndex={0} aria-label={`候補枠${index + 1}: ${slot.label}, ${slot.actionType}`} className="absolute flex items-center justify-center border-2 border-violet-700 bg-violet-200/25 text-xs font-bold text-violet-950 outline-offset-2 focus:outline focus:outline-4 focus:outline-violet-700" style={richMenuAreaStyle(slot, candidate.menuSize)}>{index + 1}</span>)}
          </div>
          <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{candidate.slots.map((slot, index) => <li key={slot.actionKey} className="rounded bg-white p-2">{index + 1}. {slot.label} ({slot.actionType})</li>)}</ol>
          <Link href="/rich-menus?candidate=1" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-violet-700 px-4 py-2 text-sm font-medium text-white">新しい配置を作成</Link>
        </div>}
      </section>}
      {readiness && <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="configuration-doctor-title">
        <h2 id="configuration-doctor-title" className="font-semibold">設定診断</h2>
        <p className="mt-2 text-sm font-bold">{readinessStatusLabel(readiness.configurationDoctor.status)}</p>
        {readiness.configurationDoctor.checks.filter((check) => check.required && check.status !== 'READY').length === 0
          ? <p className="mt-2 text-sm text-green-700">必須設定はそろっています。</p>
          : <ul className="mt-3 space-y-3">{readiness.configurationDoctor.checks
              .filter((check) => check.required && check.status !== 'READY')
              .map((check) => <li key={check.key} className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                <span className="font-medium">{readinessStatusLabel(check.status)}: {check.reasonCodes.map(reasonCodeLabel).join('、')}</span>
                <span className="mt-1 block">{check.impact}</span>
                <Link href={check.fixHref} className="mt-1 inline-block min-h-11 py-2 font-medium underline">設定を開く</Link>
              </li>)}</ul>}
      </section>}
      {readiness && <section className="grid gap-4 sm:grid-cols-2" aria-label="機能の受付条件">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold">電子処方箋の受付条件</h2>
          <p className="mt-2 text-sm font-bold">{readinessStatusLabel(readiness.electronicPrescription.status)}</p>
          <p className="mt-2 text-sm text-gray-600">Endpoint設定: {readiness.electronicPrescription.endpointConfigured ? 'あり' : 'なし'}</p>
          <p className="text-sm text-gray-600">外部確認: {readinessStatusLabel(readiness.electronicPrescription.endpointEvidence.status)}</p>
          <p className="mt-2 text-xs text-gray-500">設定済みでも、LINE Developers Consoleでの確認証拠がない場合は「未確認」と表示します。</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold">緊急避妊薬の受付条件</h2>
          <p className="mt-2 text-sm font-bold">{readinessStatusLabel(readiness.emergencyContraception.status)}</p>
          <ul className="mt-2 space-y-1 text-sm text-gray-600">
            <li>研修修了薬剤師: {readiness.emergencyContraception.trainedPharmacistAvailable ? 'あり' : 'なし'}</li>
            <li>在庫: {readiness.emergencyContraception.inventoryAvailable ? 'あり' : 'なし'}</li>
            <li>将来の受付枠: {readiness.emergencyContraception.futureSlotAvailable ? 'あり' : 'なし'}</li>
          </ul>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 sm:col-span-2">
          <h2 className="font-semibold">リッチメニュー同期</h2>
          <p className="mt-2 text-sm font-bold">{readinessStatusLabel(readiness.richMenu.syncStatus)}</p>
          <p className="mt-2 text-sm text-gray-600">{readiness.richMenu.syncStatus === 'STALE'
            ? '機能設定と公開中メニューが一致していません。候補画像を確認し、担当者が内容を確認したうえで反映してください。'
            : readiness.richMenu.syncStatus === 'CURRENT'
              ? '機能設定と公開中メニューは一致しています。'
              : '公開中メニューの実際の表示を確認できていません。'}</p>
        </div>
      </section>}
    </div>
  )
}
