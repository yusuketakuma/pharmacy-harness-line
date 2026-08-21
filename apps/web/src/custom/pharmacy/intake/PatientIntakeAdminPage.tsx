'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { pharmacyIntakeAdminApi, type PharmacyPatient, type PharmacyPatientHistory } from './api'
import { MedicationFollowUpPanel } from '../medication-followup/MedicationFollowUpPanel'

import {
  ADHERENCE_LABELS, ALCOHOL_LABELS, MEDICAL_HISTORY_TAG_LABELS, NOTEBOOK_LABELS, PREGNANCY_LABELS,
  RELATIONSHIP_LABELS, SEX_LABELS, SMOKING_LABELS, STATUS_LABELS,
} from './labels'

const HISTORY_STATUS_LABELS: Record<string, string> = {
  draft: '下書き', received: '受信', accepted: '受付済み', ready: '準備完了',
  closed: '完了', cancelled: 'キャンセル', needs_resubmission: '再提出依頼',
  fulfillable: '準備可能', conditional: '条件付き', needs_confirmation: '確認が必要', not_fulfillable: '準備不可',
  active: '継続中', linked: '次回受付へ接続', fulfilled: '履行済み', paused: '一時停止', ended: '終了',
  scheduled: '送信予約', due: '送信処理中', delivered: '回答待ち', no_issue: '問題なし',
  concern: '気になることあり', pharmacist_requested: '薬剤師への相談希望', assigned: '担当中',
  responded: '対応済み', escalated: '優先確認',
}
const NEXT_INTAKE_STATUS_LABELS: Record<string, string> = {
  offered: '患者の回答待ち', accepted: 'お知らせ登録済み', active: '送信処理中',
  reminded: 'お知らせ済み', linked: '次回受付へ接続', fulfilled: '完了',
  paused: '一時停止', ended: '登録しない',
}

export function historyStatusLabel(label: string, status: string): string {
  return label === '次回事前送信のお知らせを更新'
    ? NEXT_INTAKE_STATUS_LABELS[status] ?? status
    : HISTORY_STATUS_LABELS[status] ?? status
}

function formatHistoryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

export function createPatientListRequestGate() {
  let active: AbortController | null = null
  return {
    start() {
      active?.abort()
      active = new AbortController()
      return active
    },
    abort() {
      active?.abort()
      active = null
    },
    isCurrent(request: AbortController) {
      return active === request && !request.signal.aborted
    },
  }
}

export default function PatientIntakeAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [patients, setPatients] = useState<PharmacyPatient[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [history, setHistory] = useState<PharmacyPatientHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const listRequestGate = useRef(createPatientListRequestGate()).current
  // ponytail: patient list API has no follow-up filter yet; ?followup=attention only guides to the panel.
  const [followupFocus] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('followup') === 'attention')
  const historyRequestGate = useRef(createPatientListRequestGate()).current

  const selected = patients.find((patient) => patient.id === selectedId) ?? null
  const intake = history?.latestIntake ?? null
  const answers = intake?.answers ?? {}
  const medicalHistoryTags = Array.isArray(answers.medicalHistoryTags)
    ? answers.medicalHistoryTags.map((tag) => MEDICAL_HISTORY_TAG_LABELS[String(tag)] ?? String(tag)).join('、')
    : '未回答'

  const refreshSelectedHistory = useCallback(async () => {
    if (!selectedAccountId || !selectedId) return
    const request = historyRequestGate.start()
    setHistoryLoading(true)
    setError('')
    try {
      const result = await pharmacyIntakeAdminApi.history(selectedAccountId, selectedId, request.signal)
      if (historyRequestGate.isCurrent(request)) setHistory(result.history)
    } catch (caught) {
      if (!historyRequestGate.isCurrent(request)) return
      setError('患者情報・対応履歴を取得できませんでした。')
      throw caught
    } finally {
      if (historyRequestGate.isCurrent(request)) setHistoryLoading(false)
    }
  }, [historyRequestGate, selectedAccountId, selectedId])

  const selectPatient = (patientId: string) => {
    historyRequestGate.abort()
    setHistory(null)
    setHistoryLoading(true)
    setSelectedId(patientId)
  }

  useEffect(() => {
    if (!followupFocus || !history) return
    document.getElementById('medication-followup-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [followupFocus, history])

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const request = listRequestGate.start()
    setLoading(true)
    setError('')
    try {
      const result = await pharmacyIntakeAdminApi.list(selectedAccountId, request.signal)
      if (!listRequestGate.isCurrent(request)) return
      setPatients(result.patients)
      setSelectedId((current) => result.patients.some((patient) => patient.id === current)
        ? current
        : result.patients[0]?.id || '')
    } catch {
      if (listRequestGate.isCurrent(request)) setError('患者アンケート一覧を取得できませんでした。')
    } finally {
      if (listRequestGate.isCurrent(request)) setLoading(false)
    }
  }, [listRequestGate, selectedAccountId])

  useEffect(() => {
    setPatients([])
    setSelectedId('')
    setHistory(null)
    historyRequestGate.abort()
    if (!selectedAccountId) return
    void load()
    return () => { listRequestGate.abort() }
  }, [historyRequestGate, listRequestGate, load, selectedAccountId])

  useEffect(() => {
    if (!selectedAccountId || !selectedId) {
      historyRequestGate.abort()
      setHistory(null)
      setHistoryLoading(false)
      return
    }
    setHistory(null)
    void refreshSelectedHistory().catch(() => undefined)
    return () => { historyRequestGate.abort() }
  }, [historyRequestGate, refreshSelectedHistory, selectedAccountId, selectedId])

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-gray-900">患者アンケート</h1><p className="mt-1 text-sm text-gray-500">本人・ご家族の回答版を薬局アカウント内で確認します。</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50">再読み込み</button>
      </div>
      {followupFocus && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">服薬フォローの要対応を確認します。患者を選ぶと「服薬フォロー」欄まで移動します。</p>}
      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="patient-list-title">
          <h2 id="patient-list-title" className="font-semibold">患者一覧（{patients.length}人）</h2>
          {loading && patients.length === 0
            ? <p className="py-8 text-sm text-gray-500">患者一覧を読み込み中...</p>
            : error && patients.length === 0
              ? <p className="py-8 text-sm text-red-600">患者一覧を表示できません。再読み込みしてください。</p>
              : patients.length === 0
                ? <p className="py-8 text-sm text-gray-500">患者アンケートはありません。</p>
                : <ul className="mt-3 divide-y divide-gray-200">{patients.map((patient) => <li key={patient.id}><button type="button" onClick={() => selectPatient(patient.id)} className={`w-full p-3 text-left ${selectedId === patient.id ? 'bg-green-50' : 'hover:bg-gray-50'}`}><span className="font-medium">{patient.name}</span><span className="ml-2 text-xs text-gray-500">{RELATIONSHIP_LABELS[patient.relationship]} / {patient.birth_date}</span>{patient.archived_at && <span className="ml-2 text-xs text-gray-500">（アーカイブ）</span>}</button></li>)}</ul>}
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="intake-detail-title">
          <h2 id="intake-detail-title" className="text-lg font-semibold">回答詳細</h2>
          {!selected ? <p className="py-8 text-sm text-gray-500">患者を選択してください。</p> : historyLoading && !history ? <p className="py-8 text-sm text-gray-500">患者情報を読み込み中...</p> : !history ? <p className="py-8 text-sm text-red-600">患者情報を表示できません。再度読み込んでください。</p> : <div className="mt-4 space-y-5 text-sm"><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-gray-500">患者</dt><dd>{selected.name}</dd></div><div><dt className="text-gray-500">カナ</dt><dd>{selected.name_kana}</dd></div><div><dt className="text-gray-500">続柄</dt><dd>{RELATIONSHIP_LABELS[selected.relationship]}</dd></div><div><dt className="text-gray-500">生年月日・性別</dt><dd>{selected.birth_date} / {selected.sex ? SEX_LABELS[selected.sex] : '未登録'}</dd></div></dl><div className="rounded-lg bg-gray-50 p-4"><p><span className="font-medium">電話：</span>{selected.contact_phone || '未登録'}</p><p className="mt-2"><span className="font-medium">住所：</span>{[selected.postal_code, selected.prefecture, selected.city, selected.address_line1, selected.address_line2].filter(Boolean).join(' ') || '未登録'}</p>{!intake ? <p className="mt-3 text-gray-500">アンケート回答はまだありません。</p> : <><p className="mt-3"><span className="font-medium">最新回答：</span>第{intake.revision}版（{formatHistoryDate(intake.created_at)}）</p><p className="mt-2"><span className="font-medium">アレルギー：</span>{STATUS_LABELS[String(answers.allergiesStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">副作用経験：</span>{STATUS_LABELS[String(answers.adverseReactionStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">服用中の薬：</span>{STATUS_LABELS[String(answers.medicationStatus)] ?? '未回答'}{answers.medicationSummary ? ` / ${String(answers.medicationSummary)}` : ''}</p><p className="mt-2"><span className="font-medium">既往歴・通院：</span>{STATUS_LABELS[String(answers.medicalHistoryStatus)] ?? '未回答'}{medicalHistoryTags !== '未回答' && medicalHistoryTags ? ` / ${medicalHistoryTags}` : ''}{answers.medicalHistory ? ` / ${String(answers.medicalHistory)}` : ''}</p><p className="mt-2"><span className="font-medium">お薬手帳：</span>{NOTEBOOK_LABELS[String(answers.medicationNotebook)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">喫煙：</span>{SMOKING_LABELS[String(answers.smokingStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">飲酒：</span>{ALCOHOL_LABELS[String(answers.alcoholStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">お薬の飲み忘れ：</span>{ADHERENCE_LABELS[String(answers.medicationAdherence)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">妊娠の可能性：</span>{PREGNANCY_LABELS[String(answers.pregnancyStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">授乳中：</span>{PREGNANCY_LABELS[String(answers.breastfeedingStatus)] ?? '未回答'}</p><p className="mt-2"><span className="font-medium">連絡事項：</span>{String(answers.notes || '記載なし')}</p></>}</div><section aria-labelledby="patient-history-title"><h3 id="patient-history-title" className="font-semibold">対応履歴（新しい順）</h3>{history.timeline.length === 0 ? <p className="mt-2 text-gray-500">対応履歴はありません。</p> : <ol className="mt-2 max-h-80 space-y-2 overflow-y-auto border-l border-gray-200 pl-4">{history.timeline.map((event, index) => <li key={`${event.occurred_at}-${event.kind}-${index}`} className="relative"><span className="absolute -left-[1.35rem] top-1.5 h-2 w-2 rounded-full bg-green-500" /><p className="font-medium">{event.label}{event.status ? `：${historyStatusLabel(event.label, event.status)}` : ''}</p><p className="text-xs text-gray-500">{formatHistoryDate(event.occurred_at)}</p></li>)}</ol>}</section><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-gray-200 p-3"><p className="text-xs text-gray-500">処方せん</p><p className="mt-1 text-xl font-semibold">{history.prescriptions.length}件</p></div><div className="rounded-lg border border-gray-200 p-3"><p className="text-xs text-gray-500">受付回答</p><p className="mt-1 text-xl font-semibold">{history.quotes.length}件</p></div><div className="rounded-lg border border-gray-200 p-3"><p className="text-xs text-gray-500">継続フォロー</p><p className="mt-1 text-xl font-semibold">{history.continuity.length}件</p></div></div></div>}
        </section>
      </div>
      {history && (
        <MedicationFollowUpPanel
          accountId={selectedAccountId}
          history={history}
          onChanged={refreshSelectedHistory}
        />
      )}
    </div>
  )
}
