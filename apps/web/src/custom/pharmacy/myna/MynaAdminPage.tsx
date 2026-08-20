'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { mynaAdminApi, type MynaHandoff, type MynaVerificationStatus } from './api'

const statusLabels: Record<MynaHandoff['status'], string> = {
  CREATED: '受付開始',
  LAUNCH_REQUESTED: '外部受付を開いた',
  PATIENT_REPORTED_COMPLETE: '患者が操作完了を申告',
  PATIENT_REPORTED_NO_PRESCRIPTION: '処方箋が見つからないと申告',
  SUPPORT_NEEDED: '操作支援が必要',
  PAPER_FALLBACK: '紙へ切替',
  ABANDONED: '中断',
  EXPIRED: '期限切れ',
  CLOSED: '薬局確認済み',
}

const methodLabels: Record<MynaHandoff['method'], string> = {
  E_PRESCRIPTION: '電子処方箋',
  PAPER: '紙の処方箋',
  MEDICAL_INSTITUTION_SENT: '医療機関から送信済み',
}

const verificationLabels: Array<[MynaVerificationStatus, string]> = [
  ['E_PRESCRIPTION_RECEIVED', '電子処方箋を確認した'],
  ['CONSENT_ONLY_OR_NO_PRESCRIPTION', '同意登録のみ／処方箋なし'],
  ['NO_RECORD_FOUND', '対象処方箋が見つからない'],
  ['SUBMITTED_TO_OTHER_PHARMACY', '他薬局へ提出済み'],
  ['PRESCRIPTION_EXPIRED', '使用期限外'],
  ['PAPER_FALLBACK', '紙処方箋へ切替'],
  ['PATIENT_MISMATCH', '患者確認が必要'],
  ['MANUAL_EXCEPTION', '手動例外として記録'],
]

export function verificationOptionsForHandoffStatus(
  status: MynaHandoff['status'],
): Array<[MynaVerificationStatus, string]> {
  if (status === 'CLOSED') return []
  if (status === 'EXPIRED') return verificationLabels.filter(([value]) => value === 'PRESCRIPTION_EXPIRED')
  return verificationLabels
}

function formatTokyo(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value))
}

export function verificationConfirmationMessage(label: string): string {
  return `「${label}」として正式に記録します。記録後はこの画面から変更できません。よろしいですか？`
}

export default function MynaAdminPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [handoffs, setHandoffs] = useState<MynaHandoff[]>([])
  const [endpoint, setEndpoint] = useState<{ tenantAlias: string; endpointUrl: string; enabled: boolean }>({ tenantAlias: '', endpointUrl: '', enabled: true })
  const [endpointMasked, setEndpointMasked] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true); setError('')
    try {
      const [queue, config] = await Promise.all([
        mynaAdminApi.list(selectedAccountId),
        mynaAdminApi.endpoint(selectedAccountId),
      ])
      setHandoffs(queue.handoffs)
      if (config.endpoint) {
        setEndpoint({ tenantAlias: config.endpoint.tenant_alias, endpointUrl: '', enabled: config.endpoint.enabled })
        setEndpointMasked(config.endpoint.endpoint_url_masked)
      }
    } catch {
      setError('Myna受付の管理情報を取得できませんでした。')
    } finally { setLoading(false) }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])

  async function saveEndpoint() {
    if (!selectedAccountId || saving || !endpoint.tenantAlias || !endpoint.endpointUrl) return
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await mynaAdminApi.saveEndpoint(selectedAccountId, endpoint)
      setEndpointMasked(result.endpoint.endpoint_url_masked)
      setEndpoint((current) => ({ ...current, endpointUrl: '' }))
      setMessage('Myna受付URLを保存しました。')
    } catch {
      setError('URLを保存できませんでした。許可された公式ホストか確認してください。')
    } finally { setSaving(false) }
  }

  async function verify(handoffId: string, status: MynaVerificationStatus, label: string) {
    if (!selectedAccountId || saving) return
    if (!window.confirm(verificationConfirmationMessage(label))) return
    setSaving(true); setError(''); setMessage('')
    try {
      await mynaAdminApi.verify(selectedAccountId, handoffId, { status, sourceSystem: 'pharmacy-admin' })
      setMessage('確認結果を記録しました。')
      await load()
    } catch {
      setError('確認結果を記録できませんでした。権限または受付状態を確認してください。')
    } finally { setSaving(false) }
  }

  if (accountLoading) return <p className="py-10 text-center text-gray-500">アカウントを読み込み中...</p>
  if (!selectedAccountId) return <p className="py-10 text-center text-gray-500">LINEアカウントを登録してください。</p>

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">マイナ受付・電子処方箋</h1>
        <p className="mt-1 text-sm text-gray-500">患者操作と薬局の正式確認を分けて管理します。</p>
      </header>
      {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</div>}

      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="myna-endpoint-title">
        <h2 id="myna-endpoint-title" className="font-bold">薬局固有のMyna受付URL</h2>
        <p className="mt-1 text-sm text-gray-600">URLは暗号化して保存し、許可した公式ホスト以外へは遷移しません。</p>
        {endpointMasked && <p className="mt-2 text-sm text-gray-700">現在の設定: {endpointMasked}</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">テナント別名<input value={endpoint.tenantAlias} onChange={(event) => setEndpoint((current) => ({ ...current, tenantAlias: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="pharmacy-a" /></label>
          <label className="text-sm font-medium">公式URL<input value={endpoint.endpointUrl} onChange={(event) => setEndpoint((current) => ({ ...current, endpointUrl: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="https://..." /></label>
        </div>
        <button type="button" onClick={() => void saveEndpoint()} disabled={saving || !endpoint.tenantAlias || !endpoint.endpointUrl} className="mt-3 rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white disabled:bg-gray-300">{saving ? '保存中…' : 'URLを保存する'}</button>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white" aria-labelledby="myna-queue-title">
        <div className="flex items-center justify-between border-b p-5"><div><h2 id="myna-queue-title" className="font-bold">確認キュー</h2><p className="mt-1 text-sm text-gray-500">「手続きを終えた」は正式受付を意味しません。</p></div><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">再読み込み</button></div>
        {loading && handoffs.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">確認キューを読み込み中…</p> : error && handoffs.length === 0 ? <p className="p-8 text-center text-sm text-red-600">確認キューを表示できません。再読み込みしてください。</p> : handoffs.length === 0 ? <p className="p-8 text-center text-sm text-gray-500">確認対象はありません。</p> : <ul className="divide-y divide-gray-200">{handoffs.map((handoff) => <li key={handoff.id} className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{methodLabels[handoff.method]}・{statusLabels[handoff.status]}</p><p className="mt-1 text-xs text-gray-500">受付ID: {handoff.id}</p><p className="mt-1 text-xs text-gray-500">受付: {formatTokyo(handoff.created_at)} / 使用期限: {formatTokyo(handoff.expires_at)}</p></div></div>{verificationOptionsForHandoffStatus(handoff.status).length > 0 && <div className="flex flex-wrap gap-2">{verificationOptionsForHandoffStatus(handoff.status).map(([status, label]) => <button key={status} type="button" onClick={() => void verify(handoff.id, status, label)} disabled={saving} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">{label}</button>)}</div>}</li>)}</ul>}
      </section>
    </div>
  )
}
