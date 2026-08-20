'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '../../../contexts/account-context'
import {
  pharmacyPublicProfileAdminApi,
  type PharmacyPublicProfile,
  type PharmacyPublicProfileInput,
} from './api'

const emptyDraft: PharmacyPublicProfileInput = {
  displayName: '', phone: '', postalCode: '', address: '', businessHours: '',
  closureNotice: '', accessNote: '', parkingNote: '', googleMapsUrl: '',
}

const googleMapsPattern = /^https:\/\/(?:www\.google\.com|google\.com|maps\.google\.com|www\.google\.co\.jp|maps\.app\.goo\.gl)(?:\/|$)/i

export function publicProfileIssues(draft: PharmacyPublicProfileInput): string[] {
  return [
    !draft.displayName.trim() && '薬局名',
    !draft.address.trim() && '住所',
    !draft.businessHours.trim() && '営業時間',
    draft.googleMapsUrl.trim() !== '' && !googleMapsPattern.test(draft.googleMapsUrl.trim()) &&
      'Google Maps URL',
  ].filter((issue): issue is string => typeof issue === 'string')
}

function draftFromProfile(profile: PharmacyPublicProfile | null): PharmacyPublicProfileInput {
  if (!profile) return { ...emptyDraft }
  return {
    displayName: profile.display_name, phone: profile.phone, postalCode: profile.postal_code,
    address: profile.address, businessHours: profile.business_hours,
    closureNotice: profile.closure_notice, accessNote: profile.access_note,
    parkingNote: profile.parking_note, googleMapsUrl: profile.google_maps_url,
  }
}

export default function PharmacyInfoAdminPage() {
  const { selectedAccountId } = useAccount()
  const [draft, setDraft] = useState<PharmacyPublicProfileInput>(emptyDraft)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const result = await pharmacyPublicProfileAdminApi.get(accountId)
      if (selectedAccountRef.current !== accountId) return
      setDraft(draftFromProfile(result.profile))
      setDirty(false)
    } catch {
      if (selectedAccountRef.current === accountId) setError('薬局情報を取得できませんでした。')
    } finally {
      if (selectedAccountRef.current === accountId) setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])

  function update<K extends keyof PharmacyPublicProfileInput>(key: K, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
    setMessage('')
  }

  const issues = publicProfileIssues(draft)

  async function save() {
    if (!selectedAccountId || busy || issues.length > 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await pharmacyPublicProfileAdminApi.save(selectedAccountId, Object.fromEntries(
        Object.entries(draft).map(([key, value]) => [key, value.trim()]),
      ) as unknown as PharmacyPublicProfileInput)
      setDirty(false)
      setMessage('薬局情報を保存しました。LIFFの薬局情報ページに反映されます。')
    } catch {
      setError('薬局情報を保存できませんでした。入力内容と通信状態を確認してください。')
    } finally {
      setBusy(false)
    }
  }

  const fields: Array<{
    key: keyof PharmacyPublicProfileInput; label: string; rows?: number; maxLength: number; placeholder: string;
  }> = [
    { key: 'displayName', label: '薬局名', maxLength: 120, placeholder: '例：みどり薬局 本店' },
    { key: 'phone', label: '電話番号', maxLength: 40, placeholder: '例：03-1234-5678' },
    { key: 'postalCode', label: '郵便番号', maxLength: 16, placeholder: '例：100-0001' },
    { key: 'address', label: '住所', maxLength: 500, placeholder: '例：東京都千代田区千代田1-1' },
    { key: 'businessHours', label: '営業時間', rows: 4, maxLength: 2000, placeholder: '例：月〜金 9:00〜18:00\n土 9:00〜13:00' },
    { key: 'closureNotice', label: '休業・臨時案内', rows: 3, maxLength: 1000, placeholder: '例：日曜・祝日は休業です' },
    { key: 'accessNote', label: 'アクセス案内', rows: 3, maxLength: 1000, placeholder: '例：駅東口から徒歩3分' },
    { key: 'parkingNote', label: '駐車場案内', rows: 3, maxLength: 1000, placeholder: '例：店舗前に2台分あります' },
    { key: 'googleMapsUrl', label: 'Google Maps URL', maxLength: 2000, placeholder: '未入力なら住所から検索リンクを作成します' },
  ]

  return <div>
    <Header title="患者向け薬局情報" />
    {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
    {dirty && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">未保存の変更があります。</p>}
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
      <p className="text-sm leading-6 text-gray-600">ここで設定した公開情報が、患者のLIFF画面に表示されます。患者情報や内部メモは入力しないでください。</p>
      {loading ? <p className="text-sm text-gray-500">読み込み中...</p> : fields.map((field) => <label key={field.key} className="block text-sm font-medium text-gray-700">
        {field.label}{field.rows ? <textarea value={draft[field.key]} onChange={(event) => update(field.key, event.target.value)} rows={field.rows} maxLength={field.maxLength} disabled={busy} placeholder={field.placeholder} className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm" /> : <input type={field.key === 'googleMapsUrl' ? 'url' : field.key === 'phone' ? 'tel' : 'text'} value={draft[field.key]} onChange={(event) => update(field.key, event.target.value)} maxLength={field.maxLength} disabled={busy} placeholder={field.placeholder} className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm" />}
      </label>)}
      {issues.length > 0 && <p className="text-xs text-amber-700">確認が必要な項目：{issues.join('、')}</p>}
      <button type="button" onClick={() => void save()} disabled={busy || loading || issues.length > 0 || !selectedAccountId} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? '保存中...' : '保存する'}</button>
    </div>
  </div>
}
