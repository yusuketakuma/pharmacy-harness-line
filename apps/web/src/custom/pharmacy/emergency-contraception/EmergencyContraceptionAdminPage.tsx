'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import {
  emergencyContraceptionAdminApi,
  type AdminEmergencyIntake,
  type EmergencyAdminConfig,
  type EmergencyAvailableStaff,
  type EmergencyConfigInput,
  type EmergencyIntakeStatus,
  type EmergencyInventory,
  type EmergencyPharmacist,
  type EmergencyRiskFlag,
  type EmergencySlot,
} from './api'

const emptyConfig: EmergencyConfigInput = {
  enabled: false,
  pharmacyRegistrationNumber: '',
  productCode: '',
  purposeText: '',
  manufacturerCheckUrl: '',
  privacyPolicyUrl: '',
  privacyContact: '',
  consentVersion: '',
  retentionDays: 30,
  consultationMinutes: 30,
  reservationTtlMinutes: 30,
  privacySpaceReady: false,
  drinkingWaterReady: false,
  partnerClinicUrl: '',
  supportCenterUrl: '',
}

const emptySlotDraft = {
  pharmacistStaffId: '',
  startsAt: '',
  endsAt: '',
  capacity: '1',
}

const STATUS_LABELS: Record<EmergencyIntakeStatus, string> = {
  provisional: '未確認・仮受付',
  reviewed: '薬剤師確認済み（対面対応前）',
  completed: '店頭対応完了（販売実績は紙記録）',
  cancelled: '取消',
  expired: '期限切れ',
}

const RISK_FLAG_LABELS: Record<EmergencyRiskFlag, string> = {
  time_unknown: '性交時刻が不明',
  under_16: '16歳未満',
  minor_review: '未成年確認が必要',
  repeat_purchase_review: '直近購入の確認が必要',
  notification_unavailable: '通知できないため来局時確認が必要',
}

const AGE_BAND_LABELS: Record<AdminEmergencyIntake['age_band'], string> = {
  under_16: '16歳未満',
  '16_17': '16〜17歳',
  adult: '18歳以上',
}

const SAFE_CONTACT_LABELS: Record<AdminEmergencyIntake['safe_contact_mode'], string> = {
  neutral_line: '中立的なLINE通知',
  no_notification: '通知しない',
  phone: '電話',
  none: '連絡先なし',
}

type PharmacistDraft = { registrationNumber: string; active: boolean }
type InventoryDraft = { onHand: string; version: number }

export function emergencyIntakeStatusLabel(status: EmergencyIntakeStatus): string {
  return STATUS_LABELS[status]
}

export function emergencyRiskFlagLabel(flag: EmergencyRiskFlag): string {
  return RISK_FLAG_LABELS[flag] ?? flag
}

export function transitionConfirmationMessage(
  status: Exclude<EmergencyIntakeStatus, 'provisional'>,
): string {
  if (status === 'cancelled') {
    return 'この仮受付を取消として記録します。受付済みの枠も自動で再確保されるとは限りません。よろしいですか？'
  }
  if (status === 'completed') {
    return '店頭対応完了として記録します。これは最終適格性・販売の可否を自動判定する操作ではありません。販売実績は紙記録に残してください。よろしいですか？'
  }
  if (status === 'reviewed') {
    return '対面で確認した記録として、仮受付を薬剤師確認済みに更新します。最終適格性・販売の可否を自動判定する操作ではありません。よろしいですか？'
  }
  return 'この受付を期限切れとして記録します。よろしいですか？'
}

export function localDateTimeToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return ''
  const withSeconds = value.length === 16 ? `${value}:00` : value
  return Number.isNaN(new Date(`${withSeconds}+09:00`).valueOf()) ? '' : `${withSeconds}+09:00`
}

export function inventoryConfirmationMessage(productCode: string, onHand: number): string {
  return `商品コード ${productCode} の在庫数を${onHand}に更新します。よろしいですか？`
}

export function emergencyReadinessIssues(
  config: EmergencyConfigInput,
  pharmacists: EmergencyPharmacist[],
  inventory: EmergencyInventory[],
  slots: EmergencySlot[],
): string[] {
  const productCode = config.productCode.trim()
  return [
    !config.enabled && '受付機能',
    !config.pharmacyRegistrationNumber.trim() && '薬局登録番号',
    !productCode && '単一取扱製品',
    !config.purposeText.trim() && '利用目的',
    !config.manufacturerCheckUrl.trim() && 'メーカー公式セルフチェックURL',
    !config.privacyPolicyUrl.trim() && 'プライバシーポリシー',
    !config.privacyContact.trim() && '個人情報問い合わせ先',
    !config.consentVersion.trim() && '同意文書バージョン',
    !config.privacySpaceReady && 'プライバシー確保',
    !config.drinkingWaterReady && '飲料水',
    !config.partnerClinicUrl.trim() && '連携医療機関',
    !config.supportCenterUrl.trim() && '相談支援窓口',
    !pharmacists.some((staff) => staff.is_active === 1) && '研修修了薬剤師',
    !inventory.some((item) => item.product_code === productCode && item.on_hand > 0) && '在庫',
    !slots.some((slot) => slot.status === 'open') && '対応枠',
  ].filter((issue): issue is string => Boolean(issue))
}

function configFromSettings(settings: EmergencyAdminConfig['settings']): EmergencyConfigInput {
  if (!settings) return { ...emptyConfig }
  return {
    enabled: settings.is_enabled === 1,
    pharmacyRegistrationNumber: settings.pharmacy_registration_number,
    productCode: settings.product_code,
    purposeText: settings.purpose_text,
    manufacturerCheckUrl: settings.manufacturer_check_url,
    privacyPolicyUrl: settings.privacy_policy_url,
    privacyContact: settings.privacy_contact,
    consentVersion: settings.consent_version,
    retentionDays: settings.retention_days,
    consultationMinutes: settings.consultation_minutes,
    reservationTtlMinutes: settings.reservation_ttl_minutes,
    privacySpaceReady: settings.privacy_space_ready === 1,
    drinkingWaterReady: settings.drinking_water_ready === 1,
    partnerClinicUrl: settings.partner_clinic_url,
    supportCenterUrl: settings.support_center_url,
  }
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short',
  }).format(date)
}

function formatSlot(slot: Pick<EmergencySlot, 'starts_at' | 'ends_at'>): string {
  return `${formatDate(slot.starts_at)}〜${formatDate(slot.ends_at)}`
}

function createRequestGate() {
  let generation = 0
  return {
    start() {
      generation += 1
      return generation
    },
    abort() {
      generation += 1
    },
    isCurrent(token: number) {
      return generation === token
    },
  }
}

function initialInventoryRows(
  config: EmergencyConfigInput,
  inventory: EmergencyInventory[],
): EmergencyInventory[] {
  if (inventory.length > 0 || !config.productCode.trim()) return inventory
  return [{ product_code: config.productCode.trim(), on_hand: 0, version: 0, updated_at: '' }]
}

export default function EmergencyContraceptionAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [config, setConfig] = useState<EmergencyConfigInput>(emptyConfig)
  const [availableStaff, setAvailableStaff] = useState<EmergencyAvailableStaff[]>([])
  const [pharmacists, setPharmacists] = useState<EmergencyPharmacist[]>([])
  const [pharmacistDrafts, setPharmacistDrafts] = useState<Record<string, PharmacistDraft>>({})
  const [inventory, setInventory] = useState<EmergencyInventory[]>([])
  const [inventoryDrafts, setInventoryDrafts] = useState<Record<string, InventoryDraft>>({})
  const [slots, setSlots] = useState<EmergencySlot[]>([])
  const [intakes, setIntakes] = useState<AdminEmergencyIntake[]>([])
  const [slotDraft, setSlotDraft] = useState({ ...emptySlotDraft })
  const [newPharmacistStaffId, setNewPharmacistStaffId] = useState('')
  const [newPharmacistRegistration, setNewPharmacistRegistration] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [queueError, setQueueError] = useState('')
  const [message, setMessage] = useState('')
  const requestGate = useRef(createRequestGate()).current
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!selectedAccountId || selectedAccountRef.current !== selectedAccountId) return
    const accountId = selectedAccountId
    const request = requestGate.start()
    setLoading(true)
    setError('')
    setQueueError('')
    const [configResult, intakeResult] = await Promise.allSettled([
      emergencyContraceptionAdminApi.config(accountId),
      emergencyContraceptionAdminApi.intakes(accountId),
    ])
    if (!requestGate.isCurrent(request) || selectedAccountRef.current !== accountId) return
    if (configResult.status === 'fulfilled') {
      const result = configResult.value
      const nextConfig = configFromSettings(result.settings)
      const nextInventory = initialInventoryRows(nextConfig, result.inventory)
      setConfig(nextConfig)
      setAvailableStaff(result.available_staff ?? [])
      setPharmacists(result.pharmacists)
      setPharmacistDrafts(Object.fromEntries(result.pharmacists.map((staff) => [
        staff.staff_id,
        { registrationNumber: staff.training_registration_number, active: staff.is_active === 1 },
      ])))
      setInventory(nextInventory)
      setInventoryDrafts(Object.fromEntries(nextInventory.map((item) => [
        item.product_code,
        { onHand: String(item.on_hand), version: item.version },
      ])))
      setSlots(result.slots)
      const nextAvailableStaff = result.available_staff ?? []
      const nextActivePharmacist = result.pharmacists.find((staff) => staff.is_active === 1)?.staff_id || ''
      setNewPharmacistStaffId((current) => nextAvailableStaff.some((staff) => staff.staff_id === current)
        ? current : nextAvailableStaff[0]?.staff_id || '')
      setSlotDraft((current) => ({
        ...current,
        pharmacistStaffId: result.pharmacists.some((staff) => staff.is_active === 1 && staff.staff_id === current.pharmacistStaffId)
          ? current.pharmacistStaffId : nextActivePharmacist,
      }))
    } else {
      setError('緊急避妊薬の管理設定を取得できませんでした。')
    }
    if (intakeResult.status === 'fulfilled') {
      setIntakes(intakeResult.value.intakes)
    } else {
      setQueueError('受付キューを表示できません。研修修了薬剤師の権限または通信状態を確認してください。')
    }
    setLoading(false)
  }, [requestGate, selectedAccountId])

  useEffect(() => {
    setConfig(emptyConfig)
    setAvailableStaff([])
    setPharmacists([])
    setPharmacistDrafts({})
    setInventory([])
    setInventoryDrafts({})
    setSlots([])
    setIntakes([])
    setSlotDraft({ ...emptySlotDraft })
    setNewPharmacistStaffId('')
    setNewPharmacistRegistration('')
    setError('')
    setQueueError('')
    setMessage('')
    setBusy('')
    requestGate.abort()
    if (!selectedAccountId) {
      setLoading(false)
      return
    }
    void load()
    return () => requestGate.abort()
  }, [load, requestGate, selectedAccountId])

  async function saveConfig() {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    setBusy('config')
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.saveConfig(selectedAccountId, config)
      if (selectedAccountRef.current !== accountId) return
      setMessage('受付設定を保存しました。患者ごとの最終判断は薬剤師が対面で行ってください。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('受付設定を保存できませんでした。入力値と権限を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function savePharmacist(staffId: string) {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    const draft = pharmacistDrafts[staffId]
    if (!draft?.registrationNumber.trim()) {
      setError('研修登録番号を入力してください。')
      return
    }
    setBusy(`pharmacist:${staffId}`)
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.setPharmacist(selectedAccountId, staffId, {
        registrationNumber: draft.registrationNumber.trim(), active: draft.active,
      })
      if (selectedAccountRef.current !== accountId) return
      setMessage('研修修了薬剤師の登録を更新しました。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('研修修了薬剤師を更新できませんでした。対象スタッフの所属と権限を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function registerPharmacist() {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    if (!newPharmacistStaffId || !newPharmacistRegistration.trim()) {
      setError('スタッフと研修登録番号を入力してください。')
      return
    }
    setBusy('new-pharmacist')
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.setPharmacist(selectedAccountId, newPharmacistStaffId, {
        registrationNumber: newPharmacistRegistration.trim(), active: true,
      })
      if (selectedAccountRef.current !== accountId) return
      setNewPharmacistRegistration('')
      setMessage('研修修了薬剤師を登録しました。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('研修修了薬剤師を登録できませんでした。対象スタッフの所属と権限を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function saveInventory(productCode: string) {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    const draft = inventoryDrafts[productCode]
    const onHand = Number(draft?.onHand)
    if (!Number.isInteger(onHand) || onHand < 0) {
      setError('在庫数は0以上の整数で入力してください。')
      return
    }
    if (!window.confirm(inventoryConfirmationMessage(productCode, onHand))) return
    setBusy(`inventory:${productCode}`)
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.setInventory(selectedAccountId, {
        productCode, onHand, expectedVersion: draft?.version ?? 0,
      })
      if (selectedAccountRef.current !== accountId) return
      setMessage('在庫数を更新しました。表示は在庫の記録であり、患者ごとの販売判断ではありません。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('在庫を更新できませんでした。別の更新後は再読み込みしてから再試行してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function createSlot() {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    const startsAt = localDateTimeToIso(slotDraft.startsAt)
    const endsAt = localDateTimeToIso(slotDraft.endsAt)
    const capacity = Number(slotDraft.capacity)
    if (!slotDraft.pharmacistStaffId || !startsAt || !endsAt || !Number.isInteger(capacity) || capacity < 1) {
      setError('研修修了薬剤師、開始・終了日時、対応人数を入力してください。')
      return
    }
    setBusy('slot-create')
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.createSlot(selectedAccountId, {
        pharmacistStaffId: slotDraft.pharmacistStaffId, startsAt, endsAt, capacity,
      })
      if (selectedAccountRef.current !== accountId) return
      setSlotDraft((current) => ({ ...current, startsAt: '', endsAt: '', capacity: '1' }))
      setMessage('対応枠を登録しました。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('対応枠を登録できませんでした。日時・薬剤師・権限を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function cancelSlot(slot: EmergencySlot) {
    if (!selectedAccountId || busy || !window.confirm(
      'この対応枠を取消します。受付済みの案件がある場合は取消できないことがあります。よろしいですか？',
    )) return
    const accountId = selectedAccountId
    setBusy(`slot-cancel:${slot.id}`)
    setError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.cancelSlot(selectedAccountId, slot.id, slot.version)
      if (selectedAccountRef.current !== accountId) return
      setMessage('対応枠を取消しました。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setError('対応枠を取消できませんでした。受付済み案件または別の更新を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function transition(intake: AdminEmergencyIntake, status: Exclude<EmergencyIntakeStatus, 'provisional'>) {
    if (!selectedAccountId || busy || !window.confirm(transitionConfirmationMessage(status))) return
    const accountId = selectedAccountId
    setBusy(`intake:${intake.id}`)
    setError('')
    setQueueError('')
    setMessage('')
    try {
      await emergencyContraceptionAdminApi.transition(selectedAccountId, intake.id, status, intake.version)
      if (selectedAccountRef.current !== accountId) return
      setMessage(status === 'completed'
        ? '店頭対応完了を記録しました。販売実績は紙記録に残してください。'
        : '受付状態を更新しました。')
      await load()
    } catch {
      if (selectedAccountRef.current === accountId) setQueueError('受付状態を更新できませんでした。別のスタッフによる更新後は再読み込みしてください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  const selectableStaff = availableStaff.filter((staff) => !pharmacists.some((item) => item.staff_id === staff.staff_id))
  const activePharmacists = pharmacists.filter((staff) => staff.is_active === 1)
  const readinessIssues = emergencyReadinessIssues(config, pharmacists, inventory, slots)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">緊急避妊薬 Phase 1 管理</h1>
          <p className="mt-1 text-sm text-gray-600">受付設定、研修修了薬剤師、在庫、対応枠、受付キューをLINEアカウント単位で管理します。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
      </header>

      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        この画面は設定・受付・対応記録を管理するものです。患者ごとの最終適格性・販売の可否を自動判定しません。completed は「店頭対応完了（販売実績は紙記録）」の記録に限定します。
      </div>
      <div className={`rounded-xl border p-4 text-sm ${readinessIssues.length === 0 ? 'border-green-300 bg-green-50 text-green-950' : 'border-amber-300 bg-amber-50 text-amber-950'}`}>
        <p className="font-medium">コード上の受付条件: {readinessIssues.length === 0 ? 'そろっています' : `不足（${readinessIssues.join('、')}）`}</p>
        <p className="mt-1">この表示は厚生労働省一覧への掲載、実在庫、当日の勤務、本番公開を証明しません。運用開始前に人が確認してください。</p>
      </div>
      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</div>}

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-settings-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="emergency-settings-title" className="text-lg font-semibold">受付 readiness 設定</h2><p className="mt-1 text-sm text-gray-600">必要な運用条件と案内先を記録します。設定済みでも患者ごとの最終判断は薬剤師が行います。</p></div>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))} />受付機能を有効にする</label>
        </div>
        <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void saveConfig() }}>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">薬局登録番号<input value={config.pharmacyRegistrationNumber} onChange={(event) => setConfig((current) => ({ ...current, pharmacyRegistrationNumber: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">商品コード<input value={config.productCode} onChange={(event) => setConfig((current) => ({ ...current, productCode: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">同意文書バージョン<input value={config.consentVersion} onChange={(event) => setConfig((current) => ({ ...current, consentVersion: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
          </div>
          <label className="block text-sm font-medium">受付の目的<input value={config.purposeText} onChange={(event) => setConfig((current) => ({ ...current, purposeText: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="緊急避妊薬の対面相談受付" /></label>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">製造販売元確認URL<input type="url" value={config.manufacturerCheckUrl} onChange={(event) => setConfig((current) => ({ ...current, manufacturerCheckUrl: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">プライバシーポリシーURL<input type="url" value={config.privacyPolicyUrl} onChange={(event) => setConfig((current) => ({ ...current, privacyPolicyUrl: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">個人情報問い合わせ先<input value={config.privacyContact} onChange={(event) => setConfig((current) => ({ ...current, privacyContact: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">保管日数<input type="number" min="1" max="365" value={config.retentionDays} onChange={(event) => setConfig((current) => ({ ...current, retentionDays: Number(event.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">相談時間（分）<input type="number" min="1" max="180" value={config.consultationMinutes} onChange={(event) => setConfig((current) => ({ ...current, consultationMinutes: Number(event.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">仮受付保持時間（分）<input type="number" min="5" max="1440" value={config.reservationTtlMinutes} onChange={(event) => setConfig((current) => ({ ...current, reservationTtlMinutes: Number(event.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">連携医療機関URL<input type="url" value={config.partnerClinicUrl} onChange={(event) => setConfig((current) => ({ ...current, partnerClinicUrl: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <label className="text-sm font-medium">相談支援窓口URL<input type="url" value={config.supportCenterUrl} onChange={(event) => setConfig((current) => ({ ...current, supportCenterUrl: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={config.privacySpaceReady} onChange={(event) => setConfig((current) => ({ ...current, privacySpaceReady: event.target.checked }))} />プライバシー確保スペースを準備済み</label><label className="flex items-center gap-2"><input type="checkbox" checked={config.drinkingWaterReady} onChange={(event) => setConfig((current) => ({ ...current, drinkingWaterReady: event.target.checked }))} />服用時の飲料水を準備済み</label></div>
          <button type="submit" disabled={busy === 'config'} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'config' ? '保存中…' : '受付設定を保存'}</button>
        </form>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-pharmacists-title">
          <h2 id="emergency-pharmacists-title" className="text-lg font-semibold">研修修了薬剤師</h2>
          <p className="mt-1 text-sm text-gray-600">対応枠作成・受付キュー閲覧・状態更新はサーバー側で研修登録と所属を確認します。</p>
          {selectableStaff.length > 0 && <div className="mt-4 rounded-lg bg-gray-50 p-3"><p className="text-sm font-medium">新しいスタッフを登録</p><div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><select value={newPharmacistStaffId} onChange={(event) => setNewPharmacistStaffId(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"><option value="">スタッフを選択</option>{selectableStaff.map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.name}</option>)}</select><input value={newPharmacistRegistration} onChange={(event) => setNewPharmacistRegistration(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="研修登録番号" /><button type="button" onClick={() => void registerPharmacist()} disabled={busy !== ''} className="rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">登録</button></div></div>}
          <div className="mt-4 space-y-3">{pharmacists.length === 0 ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">研修修了薬剤師はまだ登録されていません。</p> : pharmacists.map((staff) => { const draft = pharmacistDrafts[staff.staff_id] ?? { registrationNumber: staff.training_registration_number, active: staff.is_active === 1 }; return <div key={staff.staff_id} className="rounded-lg border border-gray-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{staff.name}</p><span className={`rounded-full px-2 py-1 text-xs ${draft.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{draft.active ? '有効' : '無効'}</span></div><div className="mt-2 flex flex-wrap items-end gap-2"><label className="min-w-52 flex-1 text-sm">研修登録番号<input value={draft.registrationNumber} onChange={(event) => setPharmacistDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, registrationNumber: event.target.value } }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={draft.active} onChange={(event) => setPharmacistDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, active: event.target.checked } }))} />有効</label><button type="button" onClick={() => void savePharmacist(staff.staff_id)} disabled={busy !== ''} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">{busy === `pharmacist:${staff.staff_id}` ? '更新中…' : '更新'}</button></div></div> })}</div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-inventory-title">
          <h2 id="emergency-inventory-title" className="text-lg font-semibold">在庫</h2>
          <p className="mt-1 text-sm text-gray-600">在庫数だけを記録します。販売の可否を自動判定する表示ではありません。</p>
          <div className="mt-4 space-y-3">{inventory.length === 0 ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">商品コードを受付設定に入力して保存すると、在庫を登録できます。</p> : inventory.map((item) => { const draft = inventoryDrafts[item.product_code] ?? { onHand: String(item.on_hand), version: item.version }; return <div key={item.product_code} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3"><div className="min-w-48 flex-1"><p className="text-sm font-medium">商品コード: {item.product_code}</p><p className="mt-1 text-xs text-gray-500">更新: {item.updated_at ? formatDate(item.updated_at) : '未登録'} / version {draft.version}</p></div><label className="text-sm">在庫数<input type="number" min="0" value={draft.onHand} onChange={(event) => setInventoryDrafts((current) => ({ ...current, [item.product_code]: { ...draft, onHand: event.target.value } }))} className="mt-1 w-28 rounded-lg border border-gray-300 px-3 py-2" /></label><button type="button" onClick={() => void saveInventory(item.product_code)} disabled={busy !== ''} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">{busy === `inventory:${item.product_code}` ? '更新中…' : '在庫を更新'}</button></div> })}</div>
        </section>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-slots-title">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="emergency-slots-title" className="text-lg font-semibold">対応枠</h2><p className="mt-1 text-sm text-gray-600">研修修了薬剤師が対面対応する時間帯を登録します。</p></div></div>
        <div className="mt-4 grid gap-3 rounded-lg bg-gray-50 p-3 md:grid-cols-[1.2fr_1fr_1fr_0.6fr_auto]"><label className="text-sm">薬剤師<select value={slotDraft.pharmacistStaffId} onChange={(event) => setSlotDraft((current) => ({ ...current, pharmacistStaffId: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">選択</option>{activePharmacists.map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.name}</option>)}</select></label><label className="text-sm">開始<input type="datetime-local" value={slotDraft.startsAt} onChange={(event) => setSlotDraft((current) => ({ ...current, startsAt: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="text-sm">終了<input type="datetime-local" value={slotDraft.endsAt} onChange={(event) => setSlotDraft((current) => ({ ...current, endsAt: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="text-sm">人数<input type="number" min="1" max="20" value={slotDraft.capacity} onChange={(event) => setSlotDraft((current) => ({ ...current, capacity: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><button type="button" onClick={() => void createSlot()} disabled={busy !== ''} className="self-end rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">枠を登録</button></div>
        {slots.length === 0 ? <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-500">対応枠はありません。</p> : <div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="px-3 py-2">日時</th><th className="px-3 py-2">薬剤師</th><th className="px-3 py-2">人数</th><th className="px-3 py-2">状態</th><th className="px-3 py-2" /></tr></thead><tbody className="divide-y divide-gray-200">{slots.map((slot) => <tr key={slot.id}><td className="px-3 py-2">{formatSlot(slot)}</td><td className="px-3 py-2">{pharmacists.find((staff) => staff.staff_id === slot.pharmacist_staff_id)?.name ?? slot.pharmacist_staff_id}</td><td className="px-3 py-2">{slot.capacity}人</td><td className="px-3 py-2">{slot.status === 'open' ? '受付中' : slot.status === 'cancelled' ? '取消' : slot.status}</td><td className="px-3 py-2">{slot.status === 'open' && <button type="button" onClick={() => void cancelSlot(slot)} disabled={busy !== ''} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50">{busy === `slot-cancel:${slot.id}` ? '取消中…' : '枠を取消'}</button>}</td></tr>)}</tbody></table></div>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white" aria-labelledby="emergency-queue-title">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5"><div><h2 id="emergency-queue-title" className="text-lg font-semibold">受付キュー</h2><p className="mt-1 text-sm text-gray-600">未確認の仮受付を先に表示します。ここで最終適格性・販売の可否は自動判定しません。</p></div></div>
        {queueError && <p role="alert" className="m-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">{queueError}</p>}
         {loading && intakes.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">受付キューを読み込み中...</p> : queueError && intakes.length === 0 ? <p className="p-8 text-center text-sm text-red-600">受付キューを表示できません。再読み込みしてください。</p> : intakes.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">未確認の受付はありません。</p> : <ul className="divide-y divide-gray-200">{intakes.map((intake) => <li key={intake.id} className="space-y-3 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{emergencyIntakeStatusLabel(intake.status)}</p>{intake.status === 'provisional' && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">未確認</span>}</div><p className="mt-1 font-mono text-xs text-gray-500">受付番号: {intake.reference_code}</p><p className="mt-1 text-sm text-gray-600">対応枠: {formatSlot({ starts_at: intake.slot_starts_at, ends_at: intake.slot_ends_at })} / 期限: {formatDate(intake.expires_at)}</p></div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{AGE_BAND_LABELS[intake.age_band]}</span></div><dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-gray-500">患者申告（未確認）</dt><dd>{intake.self_reported.intercourseTimeUnknown ? '時刻不明' : formatDate(intake.self_reported.intercourseAt)}</dd></div><div><dt className="text-gray-500">連絡方法</dt><dd>{SAFE_CONTACT_LABELS[intake.safe_contact_mode]}</dd></div><div><dt className="text-gray-500">同意文書</dt><dd>{intake.consent_version}</dd></div><div><dt className="text-gray-500">更新</dt><dd>{formatDate(intake.updated_at)}</dd></div></dl><div><p className="text-sm font-medium">リスクフラグ</p>{intake.risk_flags.length === 0 ? <p className="mt-1 text-sm text-gray-500">なし</p> : <ul className="mt-1 flex flex-wrap gap-2">{intake.risk_flags.map((flag) => <li key={flag} className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">{emergencyRiskFlagLabel(flag)}</li>)}</ul>}</div><div className="flex flex-wrap gap-2">{intake.status === 'provisional' && <button type="button" onClick={() => void transition(intake, 'reviewed')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">薬剤師確認済みにする</button>}{(intake.status === 'provisional' || intake.status === 'reviewed') && <button type="button" onClick={() => void transition(intake, 'cancelled')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-50">受付を取消</button>}{(intake.status === 'provisional' || intake.status === 'reviewed') && <button type="button" onClick={() => void transition(intake, 'expired')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">期限切れとして記録</button>}{intake.status === 'reviewed' && <button type="button" onClick={() => void transition(intake, 'completed')} disabled={busy !== ''} className="min-h-11 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">店頭対応完了として記録</button>}</div></li>)}</ul>}
      </section>
    </div>
  )
}
