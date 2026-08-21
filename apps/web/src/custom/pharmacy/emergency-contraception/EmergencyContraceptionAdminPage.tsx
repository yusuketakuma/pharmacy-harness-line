'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import {
  emergencyContraceptionAdminApi,
  type AdminEmergencyIntake,
  type EmergencyAdminConfig,
  type EmergencyAvailableStaff,
  type EmergencyConfigInput,
  type EmergencyCounterConfirmation,
  type EmergencyCounterSection,
  type EmergencyIdentityCheck,
  type EmergencyInPersonDose,
  type EmergencyIntakeStatus,
  type EmergencyInventory,
  type EmergencyIntakeSummary,
  type EmergencyPharmacist,
  type EmergencyPregnancyTestResult,
  type EmergencyReferral,
  type EmergencyRiskFlag,
  type EmergencyReminderControl,
  type EmergencySaleInput,
  type EmergencySaleOutcome,
  type EmergencySaleRecord,
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

const emptyReminderControl: EmergencyReminderControl = {
  state: 'inactive', revision: 0, timeZone: 'Asia/Tokyo', updatedAt: null,
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
  pre_review_flagged: '事前申告フラグあり（対面確認が必要）',
}

type SelfReported = NonNullable<AdminEmergencyIntake['self_reported']>

const SECTION_FIELDS: Record<EmergencyCounterSection, Array<{ key: keyof SelfReported; label: string }>> = {
  A: [
    { key: 'lngAllergy', label: 'レボノルゲストレル含有薬のアレルギー歴' },
    { key: 'liverDisease', label: '肝臓病の診断' },
    { key: 'currentlyPregnant', label: '現在妊娠している' },
    { key: 'breastfeeding', label: '授乳中' },
  ],
  B: [
    { key: 'underMedicalTreatment', label: '医師の治療を受けている' },
    { key: 'drugAllergyHistory', label: '薬のアレルギー歴' },
    { key: 'heartKidneyGiDisease', label: '心臓病・腎臓病・重度の消化器疾患の診断' },
    { key: 'stJohnsWort', label: 'セイヨウオトギリソウを含む食品の摂取' },
  ],
  C: [
    { key: 'lastMenstruationDate', label: '直近の月経開始日' },
  ],
  D: [
    { key: 'idDocumentAvailable', label: '本人確認書類の持参可否' },
  ],
}

const REFUSAL_REASON_OPTIONS = [
  { value: 'age_uncertain', label: '年齢確認不能' },
  { value: 'contraindication', label: '禁忌に該当' },
  { value: 'checklist_incomplete', label: 'チェックシート不備' },
  { value: 'patient_declined', label: '本人の辞退' },
  { value: 'other', label: 'その他' },
]

const EXPLAINED_OPTIONS = [
  { value: 'three_week_check', label: '3週間後の確認' },
  { value: 'contraception_guidance', label: '避妊指導' },
  { value: 'sti_guidance', label: '性感染症' },
  { value: 'breastfeeding_24h', label: '授乳24時間' },
]

const emptySaleDraft: EmergencySaleInput = {
  expectedVersion: 0,
  outcome: 'sold',
  identityCheck: 'unverified',
  inPersonDose: 'not_done',
  checklistSheetsReceived: 0,
  pregnancyTest: 'not_done',
  refusalReasonCode: null,
  referral: 'none',
  explained: [],
}

const emptyMismatchDrafts: Record<EmergencyCounterSection, string[]> = { A: [], B: [], C: [], D: [] }

function formatSelfReportedValue(value: boolean | string | null | undefined): string {
  if (value === null || value === undefined) return '未回答'
  if (typeof value === 'boolean') return value ? 'あり' : 'なし'
  return value
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
  const [reminderControl, setReminderControl] = useState<EmergencyReminderControl>(emptyReminderControl)
  const [intakes, setIntakes] = useState<EmergencyIntakeSummary[]>([])
  const [selectedDetail, setSelectedDetail] = useState<AdminEmergencyIntake | null>(null)
  const [counterConfirmations, setCounterConfirmations] = useState<Partial<Record<EmergencyCounterSection, EmergencyCounterConfirmation>>>({})
  const [mismatchDrafts, setMismatchDrafts] = useState<Record<EmergencyCounterSection, string[]>>({ ...emptyMismatchDrafts })
  const [saleRecord, setSaleRecord] = useState<EmergencySaleRecord | null>(null)
  const [saleDraft, setSaleDraft] = useState<EmergencySaleInput>({ ...emptySaleDraft })
  const [statusFilter, setStatusFilter] = useState<EmergencyIntakeStatus | ''>('')
  const [slotFilter, setSlotFilter] = useState('')
  const [deadlineFilter, setDeadlineFilter] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [slotDraft, setSlotDraft] = useState({ ...emptySlotDraft })
  const [newPharmacistStaffId, setNewPharmacistStaffId] = useState('')
  const [newPharmacistRegistration, setNewPharmacistRegistration] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [queueError, setQueueError] = useState('')
  const [message, setMessage] = useState('')
  const requestGate = useRef(createRequestGate()).current
  const queueFiltersRef = useRef({ status: statusFilter, slotId: slotFilter, deadlineBefore: '' })
  queueFiltersRef.current = {
    status: statusFilter,
    slotId: slotFilter,
    deadlineBefore: localDateTimeToIso(deadlineFilter),
  }
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!selectedAccountId || selectedAccountRef.current !== selectedAccountId) return
    const accountId = selectedAccountId
    const request = requestGate.start()
    setLoading(true)
    setError('')
    setQueueError('')
    const [configResult, intakeResult, reminderResult] = await Promise.allSettled([
      emergencyContraceptionAdminApi.config(accountId),
      emergencyContraceptionAdminApi.intakes(accountId, { ...queueFiltersRef.current, limit: 50 }),
      emergencyContraceptionAdminApi.reminderControl(accountId),
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
      setNextCursor(intakeResult.value.next_cursor)
      setSelectedDetail(null)
    } else {
      setQueueError('受付キューを表示できません。研修修了薬剤師の権限または通信状態を確認してください。')
    }
    if (reminderResult.status === 'fulfilled') setReminderControl(reminderResult.value)
    else setError('予約前通知の設定を取得できませんでした。')
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
    setReminderControl(emptyReminderControl)
    setIntakes([])
    setSelectedDetail(null)
    setCounterConfirmations({})
    setMismatchDrafts({ ...emptyMismatchDrafts })
    setSaleRecord(null)
    setSaleDraft({ ...emptySaleDraft })
    setStatusFilter('')
    setSlotFilter('')
    setDeadlineFilter('')
    setNextCursor(null)
    queueFiltersRef.current = { status: '', slotId: '', deadlineBefore: '' }
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

  async function toggleReminderControl() {
    if (!selectedAccountId || busy || reminderControl.state === 'frozen') return
    const accountId = selectedAccountId
    const state = reminderControl.state === 'active' ? 'inactive' : 'active'
    if (state === 'active' && !window.confirm(
      '予約1時間前の中立的なLINE通知を有効にします。通知を希望した受付だけが対象です。よろしいですか？',
    )) return
    setBusy('reminder-control')
    setError('')
    setMessage('')
    try {
      const saved = await emergencyContraceptionAdminApi.saveReminderControl(accountId, {
        state, expectedRevision: reminderControl.revision,
      })
      if (selectedAccountRef.current !== accountId) return
      setReminderControl(saved)
      setMessage(state === 'active' ? '予約前の中立LINE通知を有効にしました。' : '予約前の中立LINE通知を無効にしました。')
    } catch {
      if (selectedAccountRef.current === accountId) setError('予約前通知の設定を更新できませんでした。再読み込みしてから再試行してください。')
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

  async function loadIntakeDetail(intakeId: string) {
    if (!selectedAccountId || busy) return
    const accountId = selectedAccountId
    setBusy(`detail:${intakeId}`)
    setQueueError('')
    try {
      const result = await emergencyContraceptionAdminApi.intakeDetail(accountId, intakeId)
      if (selectedAccountRef.current !== accountId) return
      setSelectedDetail(result.intake)
      const sections: EmergencyCounterSection[] = ['A', 'B', 'C', 'D']
      const confirmations = await Promise.all(sections.map((section) => emergencyContraceptionAdminApi
        .counterConfirmation(accountId, intakeId, section)
        .then((response) => response.confirmation)
        .catch(() => null)))
      if (selectedAccountRef.current !== accountId) return
      setCounterConfirmations(Object.fromEntries(
        sections.map((section, index) => [section, confirmations[index]]).filter(([, value]) => value),
      ))
      try {
        const sale = await emergencyContraceptionAdminApi.saleRecord(accountId, intakeId)
        if (selectedAccountRef.current === accountId) setSaleRecord(sale.sale)
      } catch {
        if (selectedAccountRef.current === accountId) setSaleRecord(null)
      }
      setSaleDraft((current) => ({ ...current, expectedVersion: result.intake.version }))
    } catch {
      if (selectedAccountRef.current === accountId) setQueueError('申告詳細を表示できません。研修修了状態と通信状態を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function confirmSection(intake: EmergencyIntakeSummary, section: EmergencyCounterSection) {
    if (!selectedAccountId || busy || selectedDetail?.id !== intake.id) return
    if (!window.confirm(`セクション${section}を対面で確認した記録として登録します。よろしいですか？`)) return
    const accountId = selectedAccountId
    setBusy(`confirm:${section}`)
    setError('')
    setMessage('')
    try {
      const checklistVersion = selectedDetail.self_reported?.checklistVersion || 'lng-2026-08'
      const result = await emergencyContraceptionAdminApi.confirmCounterSection(accountId, intake.id, section, {
        checklistVersion, mismatchItems: mismatchDrafts[section],
      })
      if (selectedAccountRef.current !== accountId) return
      setCounterConfirmations((current) => ({ ...current, [section]: result.confirmation }))
      setMessage(`セクション${section}の対面確認を記録しました。`)
    } catch {
      if (selectedAccountRef.current === accountId) {
        setError('対面確認を記録できませんでした。最新の状態を確認してください。')
        await loadIntakeDetail(intake.id)
      }
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function submitSale(intake: EmergencyIntakeSummary) {
    if (!selectedAccountId || busy || selectedDetail?.id !== intake.id) return
    if (!window.confirm(saleDraft.outcome === 'sold'
      ? '販売した記録として保存します。この操作は最終適格性を自動判定しません。よろしいですか？'
      : '販売しなかった記録として保存します。よろしいですか？')) return
    const accountId = selectedAccountId
    setBusy('sale')
    setError('')
    setMessage('')
    try {
      const result = await emergencyContraceptionAdminApi.recordSale(accountId, intake.id, {
        ...saleDraft,
        expectedVersion: selectedDetail.version,
        refusalReasonCode: saleDraft.outcome === 'refused' ? (saleDraft.refusalReasonCode || null) : null,
      })
      if (selectedAccountRef.current !== accountId) return
      setSaleRecord(result.sale)
      setMessage('薬剤師記入欄の内容を販売記録として保存しました。')
      await load()
      await loadIntakeDetail(intake.id)
    } catch {
      if (selectedAccountRef.current === accountId) {
        setError('販売記録を保存できませんでした。最新の状態を確認してください。')
        await loadIntakeDetail(intake.id)
      }
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function loadQueue(cursor?: string, append = false) {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    setBusy(append ? 'queue-more' : 'queue-filter')
    setQueueError('')
    try {
      const result = await emergencyContraceptionAdminApi.intakes(accountId, {
        ...queueFiltersRef.current,
        cursor,
        limit: 50,
      })
      if (selectedAccountRef.current !== accountId) return
      setIntakes((current) => append ? [...current, ...result.intakes] : result.intakes)
      setNextCursor(result.next_cursor)
      if (!append) setSelectedDetail(null)
    } catch {
      if (selectedAccountRef.current === accountId) setQueueError('受付キューを表示できません。研修修了薬剤師の権限または通信状態を確認してください。')
    } finally {
      if (selectedAccountRef.current === accountId) setBusy('')
    }
  }

  async function transition(intake: EmergencyIntakeSummary, status: Exclude<EmergencyIntakeStatus, 'provisional'>) {
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
          <h1 className="text-2xl font-bold text-gray-900">緊急避妊薬</h1>
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

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-reminder-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="emergency-reminder-title" className="text-lg font-semibold">予約前の中立LINE通知</h2>
            <p className="mt-1 text-sm text-gray-600">通知を希望した受付へ、予約1時間前に内容を特定しない定型文だけを送ります。日本時間の21時〜8時は送信しません。</p>
            <p className="mt-1 text-xs text-gray-500">状態: {reminderControl.state === 'active' ? '有効' : reminderControl.state === 'frozen' ? '停止固定' : '無効'}</p>
          </div>
          <button type="button" onClick={() => void toggleReminderControl()} disabled={busy !== '' || reminderControl.state === 'frozen'} aria-pressed={reminderControl.state === 'active'} className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${reminderControl.state === 'active' ? 'border border-red-300 bg-white text-red-700' : 'bg-green-600 text-white'}`}>
            {busy === 'reminder-control' ? '更新中…' : reminderControl.state === 'active' ? '通知を無効にする' : reminderControl.state === 'frozen' ? '停止固定中' : '通知を有効にする'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-settings-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="emergency-settings-title" className="text-lg font-semibold">受付条件の設定</h2><p className="mt-1 text-sm text-gray-600">必要な運用条件と案内先を記録します。設定済みでも患者ごとの最終判断は薬剤師が行います。</p></div>
          <p className="text-sm font-medium">受付機能: {config.enabled ? '有効' : '無効'}（機能設定で変更）</p>
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
          <div className="mt-4 space-y-3">{inventory.length === 0 ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">商品コードを受付設定に入力して保存すると、在庫を登録できます。</p> : inventory.map((item) => { const draft = inventoryDrafts[item.product_code] ?? { onHand: String(item.on_hand), version: item.version }; return <div key={item.product_code} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3"><div className="min-w-48 flex-1"><p className="text-sm font-medium">商品コード: {item.product_code}</p><p className="mt-1 text-xs text-gray-500">更新: {item.updated_at ? formatDate(item.updated_at) : '未登録'}</p></div><label className="text-sm">在庫数<input type="number" min="0" value={draft.onHand} onChange={(event) => setInventoryDrafts((current) => ({ ...current, [item.product_code]: { ...draft, onHand: event.target.value } }))} className="mt-1 w-28 rounded-lg border border-gray-300 px-3 py-2" /></label><button type="button" onClick={() => void saveInventory(item.product_code)} disabled={busy !== ''} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">{busy === `inventory:${item.product_code}` ? '更新中…' : '在庫を更新'}</button></div> })}</div>
        </section>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="emergency-slots-title">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="emergency-slots-title" className="text-lg font-semibold">対応枠</h2><p className="mt-1 text-sm text-gray-600">研修修了薬剤師が対面対応する時間帯を登録します。</p></div></div>
        <div className="mt-4 grid gap-3 rounded-lg bg-gray-50 p-3 md:grid-cols-[1.2fr_1fr_1fr_0.6fr_auto]"><label className="text-sm">薬剤師<select value={slotDraft.pharmacistStaffId} onChange={(event) => setSlotDraft((current) => ({ ...current, pharmacistStaffId: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">選択</option>{activePharmacists.map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.name}</option>)}</select></label><label className="text-sm">開始<input type="datetime-local" value={slotDraft.startsAt} onChange={(event) => setSlotDraft((current) => ({ ...current, startsAt: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="text-sm">終了<input type="datetime-local" value={slotDraft.endsAt} onChange={(event) => setSlotDraft((current) => ({ ...current, endsAt: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><label className="text-sm">人数<input type="number" min="1" max="20" value={slotDraft.capacity} onChange={(event) => setSlotDraft((current) => ({ ...current, capacity: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><button type="button" onClick={() => void createSlot()} disabled={busy !== ''} className="self-end rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">枠を登録</button></div>
        {slots.length === 0 ? <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-500">対応枠はありません。</p> : <div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-gray-500"><tr><th className="px-3 py-2">日時</th><th className="px-3 py-2">薬剤師</th><th className="px-3 py-2">人数</th><th className="px-3 py-2">状態</th><th className="px-3 py-2" /></tr></thead><tbody className="divide-y divide-gray-200">{slots.map((slot) => <tr key={slot.id}><td className="px-3 py-2">{formatSlot(slot)}</td><td className="px-3 py-2">{pharmacists.find((staff) => staff.staff_id === slot.pharmacist_staff_id)?.name ?? slot.pharmacist_staff_id}</td><td className="px-3 py-2">{slot.capacity}人</td><td className="px-3 py-2">{slot.status === 'open' ? '受付中' : slot.status === 'cancelled' ? '取消' : slot.status}</td><td className="px-3 py-2">{slot.status === 'open' && <button type="button" onClick={() => void cancelSlot(slot)} disabled={busy !== ''} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50">{busy === `slot-cancel:${slot.id}` ? '取消中…' : '枠を取消'}</button>}</td></tr>)}</tbody></table></div>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white" aria-labelledby="emergency-queue-title">
        <div className="border-b p-5">
          <h2 id="emergency-queue-title" className="text-lg font-semibold">受付キュー</h2>
          <p className="mt-1 text-sm text-gray-600">新しい受付から表示します。ここで最終適格性・販売の可否は自動判定しません。</p>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1.5fr_1.2fr_auto]">
            <label className="text-sm">状態<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as EmergencyIntakeStatus | '')} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">すべて</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-sm">対応枠<select value={slotFilter} onChange={(event) => setSlotFilter(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">すべて</option>{slots.map((slot) => <option key={slot.id} value={slot.id}>{formatSlot(slot)}</option>)}</select></label>
            <label className="text-sm">期限まで<input type="datetime-local" value={deadlineFilter} onChange={(event) => setDeadlineFilter(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
            <button type="button" onClick={() => void loadQueue()} disabled={busy !== ''} className="min-h-11 self-end rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">絞り込む</button>
          </div>
        </div>
        {queueError && <p role="alert" className="m-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">{queueError}</p>}
         {loading && intakes.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">受付キューを読み込み中...</p> : queueError && intakes.length === 0 ? <p className="p-8 text-center text-sm text-red-600">受付キューを表示できません。再読み込みしてください。</p> : intakes.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">該当する受付はありません。</p> : <><ul className="divide-y divide-gray-200">{intakes.map((intake) => <li key={intake.id} className="space-y-3 p-5"><div><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{emergencyIntakeStatusLabel(intake.status)}</p>{intake.status === 'provisional' && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">未確認</span>}</div><p className="mt-1 font-mono text-xs text-gray-500">受付番号: {intake.reference_code}</p><p className="mt-1 text-sm text-gray-600">対応枠: {formatSlot({ starts_at: intake.slot_starts_at, ends_at: intake.slot_ends_at })} / 期限: {formatDate(intake.expires_at)}</p></div><dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-gray-500">患者申告（未確認）</dt><dd>{selectedDetail?.id === intake.id ? (selectedDetail.self_reported ? (selectedDetail.self_reported.intercourseTimeUnknown ? '時刻不明' : formatDate(selectedDetail.self_reported.intercourseAt)) : '保存期間経過のため削除済み') : <button type="button" onClick={() => void loadIntakeDetail(intake.id)} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">{busy === `detail:${intake.id}` ? '確認中…' : '申告詳細を確認'}</button>}</dd></div><div><dt className="text-gray-500">年齢帯</dt><dd>{selectedDetail?.id === intake.id ? AGE_BAND_LABELS[selectedDetail.age_band] : '詳細確認後に表示'}</dd></div><div><dt className="text-gray-500">連絡方法</dt><dd>{selectedDetail?.id === intake.id ? SAFE_CONTACT_LABELS[selectedDetail.safe_contact_mode] : '詳細確認後に表示'}</dd></div><div><dt className="text-gray-500">同意文書</dt><dd>{selectedDetail?.id === intake.id ? selectedDetail.consent_version : '詳細確認後に表示'}</dd></div></dl><div><p className="text-sm font-medium">リスクフラグ</p>{selectedDetail?.id !== intake.id ? <p className="mt-1 text-sm text-gray-500">詳細確認後に表示</p> : selectedDetail.risk_flags.length === 0 ? <p className="mt-1 text-sm text-gray-500">なし</p> : <ul className="mt-1 flex flex-wrap gap-2">{selectedDetail.risk_flags.map((flag) => <li key={flag} className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">{emergencyRiskFlagLabel(flag)}</li>)}</ul>}</div>
              {selectedDetail?.id === intake.id && selectedDetail.self_reported && <div className="space-y-3 rounded-lg border border-gray-200 p-4">
                <p className="text-sm font-medium">申告（未確認）</p>
                {(Object.keys(SECTION_FIELDS) as EmergencyCounterSection[]).map((section) => {
                  const confirmation = counterConfirmations[section]
                  const selfReported = selectedDetail.self_reported as SelfReported
                  return <div key={section} className="rounded-lg bg-gray-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">セクション{section}</p>
                      {confirmation ? <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-800">対面で確認した（{confirmation.staff_id}）</span> : <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">未確認</span>}
                    </div>
                    <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                      {SECTION_FIELDS[section].map(({ key, label }) => <div key={String(key)}><dt className="text-gray-500">{label}</dt><dd>{formatSelfReportedValue(selfReported[key] as boolean | string | null)}</dd></div>)}
                    </dl>
                    {section === 'C' && <p className="mt-1 text-xs text-amber-900">薬剤師のみ表示: 妊娠検査推奨 {selfReported.pregnancyTestRecommended ? 'あり' : 'なし'}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="text-xs text-gray-600">申告と相違があった項目
                        <select multiple value={mismatchDrafts[section]} onChange={(event) => setMismatchDrafts((current) => ({ ...current, [section]: Array.from(event.target.selectedOptions, (option) => option.value) }))} className="mt-1 min-h-16 w-full rounded-lg border border-gray-300 px-2 py-1 text-xs">
                          {SECTION_FIELDS[section].map(({ key, label }) => <option key={String(key)} value={String(key)}>{label}</option>)}
                        </select>
                      </label>
                      <button type="button" onClick={() => void confirmSection(intake, section)} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">{busy === `confirm:${section}` ? '記録中…' : '対面で確認した'}</button>
                    </div>
                  </div>
                })}
              </div>}
              {intake.status === 'reviewed' && selectedDetail?.id === intake.id && <div className="rounded-lg border border-gray-200 p-4" aria-label="薬剤師記入欄">
                <p className="text-sm font-semibold">薬剤師記入欄</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">本人確認<select value={saleDraft.identityCheck} onChange={(event) => setSaleDraft((current) => ({ ...current, identityCheck: event.target.value as EmergencyIdentityCheck }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="document">書類</option><option value="verbal">口頭</option><option value="unverified">未確認</option></select></label>
                  <label className="text-sm">妊娠検査<select value={saleDraft.pregnancyTest} onChange={(event) => setSaleDraft((current) => ({ ...current, pregnancyTest: event.target.value as EmergencyPregnancyTestResult }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="not_done">未実施</option><option value="negative">陰性</option><option value="positive">陽性</option></select></label>
                  <label className="text-sm">販売<select value={saleDraft.outcome} onChange={(event) => setSaleDraft((current) => ({ ...current, outcome: event.target.value as EmergencySaleOutcome }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="sold">販売した</option><option value="refused">販売しなかった</option></select></label>
                  {saleDraft.outcome === 'refused' && <label className="text-sm">販売しなかった理由<select value={saleDraft.refusalReasonCode ?? ''} onChange={(event) => setSaleDraft((current) => ({ ...current, refusalReasonCode: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="">選択</option>{REFUSAL_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
                  <label className="text-sm">面前服用<select value={saleDraft.inPersonDose} onChange={(event) => setSaleDraft((current) => ({ ...current, inPersonDose: event.target.value as EmergencyInPersonDose }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="done">実施</option><option value="not_done">未実施</option></select></label>
                  <label className="text-sm">受診勧奨・紹介<select value={saleDraft.referral} onChange={(event) => setSaleDraft((current) => ({ ...current, referral: event.target.value as EmergencyReferral }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"><option value="none">なし</option><option value="obgyn">産婦人科</option><option value="pediatrics">小児科</option><option value="onestop">ワンストップ</option><option value="child_guidance">児相通告</option></select></label>
                  <label className="text-sm">紙チェックシート受領枚数<input type="number" min="0" value={saleDraft.checklistSheetsReceived} onChange={(event) => setSaleDraft((current) => ({ ...current, checklistSheetsReceived: Number(event.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
                </div>
                <fieldset className="mt-2 flex flex-wrap gap-3 text-sm"><legend className="text-sm text-gray-600">説明済み</legend>{EXPLAINED_OPTIONS.map((option) => <label key={option.value} className="flex items-center gap-2"><input type="checkbox" checked={saleDraft.explained.includes(option.value)} onChange={(event) => setSaleDraft((current) => ({ ...current, explained: event.target.checked ? [...current.explained, option.value] : current.explained.filter((item) => item !== option.value) }))} />{option.label}</label>)}</fieldset>
                <button type="button" onClick={() => void submitSale(intake)} disabled={busy !== ''} className="mt-3 min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'sale' ? '保存中…' : saleDraft.outcome === 'sold' ? '販売可として記録' : '販売しなかったとして記録'}</button>
                {saleRecord && <p className="mt-2 text-xs text-gray-500">販売記録: {saleRecord.outcome === 'sold' ? '販売済み' : '販売しなかった'}（{formatDate(saleRecord.sold_at)}）</p>}
              </div>}
              <div className="flex flex-wrap gap-2">{intake.status === 'provisional' && <button type="button" onClick={() => void transition(intake, 'reviewed')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">薬剤師確認済みにする</button>}{(intake.status === 'provisional' || intake.status === 'reviewed') && <button type="button" onClick={() => void transition(intake, 'cancelled')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-50">受付を取消</button>}{(intake.status === 'provisional' || intake.status === 'reviewed') && <button type="button" onClick={() => void transition(intake, 'expired')} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">期限切れとして記録</button>}{intake.status === 'reviewed' && <button type="button" onClick={() => void transition(intake, 'completed')} disabled={busy !== ''} className="min-h-11 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">店頭対応完了として記録</button>}</div></li>)}</ul>{nextCursor && <div className="border-t p-4 text-center"><button type="button" onClick={() => void loadQueue(nextCursor, true)} disabled={busy !== ''} className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">{busy === 'queue-more' ? '読込中…' : '次を表示'}</button></div>}</>}
      </section>
    </div>
  )
}
