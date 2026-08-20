'use client'

import React, { useEffect, useMemo, useState } from 'react'
import type { MedicalSource, PrescriptionSource, PrescriptionValidity } from './api'

type SourceInput = { sourceId: string | null; classification: 'primary' | 'other' | 'unknown' }
type ValidityInput = {
  issuedOn: string | null
  validUntil: string | null
  validityBasis: 'default_4_days' | 'prescriber_specified'
  verificationStatus: PrescriptionValidity['verification_status']
}

function defaultValidUntil(issuedOn: string): string {
  if (!issuedOn) return ''
  const date = new Date(`${issuedOn}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 3)
  return date.toISOString().slice(0, 10)
}

export function PrescriptionReviewEditor({
  accountId,
  submissionId,
  source,
  validity,
  medicalSources,
  onSaveSource = async () => undefined,
  onSaveValidity = async () => undefined,
  onSaved,
}: {
  accountId: string
  submissionId: string
  source: PrescriptionSource | null
  validity: PrescriptionValidity | null
  medicalSources: MedicalSource[]
  onSaveSource?: (accountId: string, submissionId: string, input: SourceInput) => Promise<void>
  onSaveValidity?: (accountId: string, submissionId: string, input: ValidityInput) => Promise<void>
  onSaved: () => void
}) {
  const [classification, setClassification] = useState<SourceInput['classification']>(source?.classification ?? 'unknown')
  const [sourceId, setSourceId] = useState(source?.source_id ?? '')
  const [issuedOn, setIssuedOn] = useState(validity?.issued_on ?? '')
  const [validUntil, setValidUntil] = useState(validity?.valid_until ?? '')
  const [basis, setBasis] = useState<ValidityInput['validityBasis']>(validity?.validity_basis ?? 'default_4_days')
  const [verification, setVerification] = useState<ValidityInput['verificationStatus']>(validity?.verification_status ?? 'unverified')
  const [saving, setSaving] = useState<'source' | 'validity' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setClassification(source?.classification ?? 'unknown')
    setSourceId(source?.source_id ?? '')
  }, [source, submissionId])

  useEffect(() => {
    setIssuedOn(validity?.issued_on ?? '')
    setValidUntil(validity?.valid_until ?? '')
    setBasis(validity?.validity_basis ?? 'default_4_days')
    setVerification(validity?.verification_status ?? 'unverified')
  }, [submissionId, validity])

  const choices = useMemo(() => medicalSources.filter((item) =>
    item.classification === classification && (item.is_active === 1 || item.id === source?.source_id),
  ), [classification, medicalSources, source?.source_id])

  const saveSource = async () => {
    if (classification !== 'unknown' && !sourceId) return setError('発行元を選択してください。')
    setSaving('source'); setError('')
    try {
      await onSaveSource(accountId, submissionId, {
        classification,
        sourceId: classification === 'unknown' ? null : sourceId,
      })
      onSaved()
    } catch { setError('発行元分類を保存できませんでした。') } finally { setSaving(null) }
  }

  const saveValidity = async () => {
    setSaving('validity'); setError('')
    try {
      await onSaveValidity(accountId, submissionId, {
        issuedOn: issuedOn || null,
        validUntil: basis === 'prescriber_specified' ? validUntil || null : null,
        validityBasis: basis,
        verificationStatus: verification,
      })
      onSaved()
    } catch { setError('処方せん使用期限を保存できませんでした。') } finally { setSaving(null) }
  }

  return <section className="rounded-lg border border-blue-200 bg-blue-50 p-4" aria-labelledby="prescription-review-title">
    <h3 id="prescription-review-title" className="font-semibold">薬剤師確認</h3>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <div className="mt-3 grid gap-5 lg:grid-cols-2">
      <fieldset className="space-y-3">
        <legend className="font-medium">発行元分類</legend>
        <label className="block text-sm">区分
          <select value={classification} onChange={(event) => { setClassification(event.target.value as SourceInput['classification']); setSourceId('') }} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="unknown">不明</option><option value="primary">主な発行元</option><option value="other">その他の発行元</option>
          </select>
        </label>
        {classification !== 'unknown' && <label className="block text-sm">医療機関
          <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="">選択してください</option>
            {choices.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}
          </select>
        </label>}
        <button type="button" onClick={() => void saveSource()} disabled={saving !== null} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">発行元を保存</button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-medium">処方せん使用期限</legend>
        <label className="block text-sm">交付日<input type="date" value={issuedOn} onChange={(event) => setIssuedOn(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" /></label>
        <label className="block text-sm">期限の根拠
          <select value={basis} onChange={(event) => setBasis(event.target.value as ValidityInput['validityBasis'])} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="default_4_days">交付日を含めて4日</option><option value="prescriber_specified">処方医・歯科医師の指定</option>
          </select>
        </label>
        {basis === 'default_4_days'
          ? <p className="text-sm text-gray-600">使用期限: {defaultValidUntil(issuedOn) || '交付日を入力してください'}</p>
          : <label className="block text-sm">指定された使用期限<input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" /></label>}
        <label className="block text-sm">確認状態
          <select value={verification} onChange={(event) => setVerification(event.target.value as ValidityInput['verificationStatus'])} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="unverified">未確認</option><option value="verified">確認済み</option><option value="expired_review_required">期限確認が必要</option><option value="expired_confirmed">期限切れ確認済み</option>
          </select>
        </label>
        <button type="button" onClick={() => void saveValidity()} disabled={saving !== null} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">使用期限を保存</button>
      </fieldset>
    </div>
  </section>
}
