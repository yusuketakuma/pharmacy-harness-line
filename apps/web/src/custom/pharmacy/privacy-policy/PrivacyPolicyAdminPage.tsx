'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import Header from '@/components/layout/header'
import {
  pharmacyPrivacyPolicyApi,
  type TenantPrivacyPolicy,
  type TenantPrivacyPolicyInput,
} from './api'

const emptyDraft: TenantPrivacyPolicyInput = {
  purposeText: '',
  purposeUrl: '',
  contactPoint: '',
  entrustmentText: '',
}

export function privacyPolicyIssues(draft: TenantPrivacyPolicyInput): string[] {
  return [
    !draft.purposeText.trim() && '利用目的',
    !draft.contactPoint.trim() && '問い合わせ窓口',
    !draft.entrustmentText.trim() && '委託関係の説明',
    draft.purposeUrl.trim() !== '' && !/^https:\/\/\S+$/.test(draft.purposeUrl.trim()) &&
      '利用目的の掲載URL（https://で始まる形式）',
  ].filter((issue): issue is string => typeof issue === 'string')
}

function draftFromPolicy(policy: TenantPrivacyPolicy | null): TenantPrivacyPolicyInput {
  if (!policy) return { ...emptyDraft }
  return {
    purposeText: policy.purpose_text,
    purposeUrl: policy.purpose_url,
    contactPoint: policy.contact_point,
    entrustmentText: policy.entrustment_text,
  }
}

export default function PrivacyPolicyAdminPage() {
  const { selectedAccountId } = useAccount()
  const [policy, setPolicy] = useState<TenantPrivacyPolicy | null>(null)
  const [draft, setDraft] = useState<TenantPrivacyPolicyInput>(emptyDraft)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
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
    setPolicy(null)
    setDraft(emptyDraft)
    try {
      const result = await pharmacyPrivacyPolicyApi.get(accountId)
      if (selectedAccountRef.current !== accountId) return
      setPolicy(result.policy)
      setDraft(draftFromPolicy(result.policy))
    } catch {
      if (selectedAccountRef.current !== accountId) return
      setError('個人情報の取扱いに関する掲示内容を取得できませんでした。')
    } finally {
      if (selectedAccountRef.current === accountId) setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => { void load() }, [load])

  const issues = privacyPolicyIssues(draft)

  async function save() {
    if (!selectedAccountId || busy || issues.length > 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await pharmacyPrivacyPolicyApi.save(selectedAccountId, {
        purposeText: draft.purposeText.trim(),
        purposeUrl: draft.purposeUrl.trim(),
        contactPoint: draft.contactPoint.trim(),
        entrustmentText: draft.entrustmentText.trim(),
      })
      setMessage('掲示内容を保存しました。患者アンケートの同意欄に反映されます。')
      await load()
    } catch {
      setError('掲示内容を保存できませんでした。入力内容と通信状態を確認してください。')
    } finally {
      setBusy(false)
    }
  }

  function update<K extends keyof TenantPrivacyPolicyInput>(key: K, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  return (
    <div>
      <Header title="個人情報の取扱い（患者向け掲示）" />

      <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <p className="font-bold">この内容は貴薬局の名義で患者に表示されます。</p>
        <p className="mt-1 text-xs leading-5">
          患者の個人情報について個人情報取扱事業者となるのは貴薬局です。
          本システムの運営事業者は、貴薬局からの委託を受けて情報を取り扱う受託者にあたります。
          利用目的・問い合わせ窓口・委託関係の説明は、貴薬局の判断で記載してください。
        </p>
      </div>

      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}

      <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
        {loading ? <p className="text-sm text-gray-500">読み込み中...</p> : (
          <>
            <label className="block text-sm font-medium text-gray-700">
              利用目的
              <textarea
                value={draft.purposeText}
                onChange={(event) => update('purposeText', event.target.value)}
                rows={4}
                maxLength={4000}
                disabled={busy}
                placeholder="例：調剤・服薬指導、薬歴管理、および必要な連絡のために利用します。"
                className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm"
              />
            </label>

            <label className="block text-sm font-medium text-gray-700">
              利用目的の掲載URL（任意）
              <input
                type="url"
                value={draft.purposeUrl}
                onChange={(event) => update('purposeUrl', event.target.value)}
                maxLength={2000}
                disabled={busy}
                placeholder="https://example.com/privacy"
                className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm"
              />
            </label>

            <label className="block text-sm font-medium text-gray-700">
              問い合わせ窓口
              <input
                type="text"
                value={draft.contactPoint}
                onChange={(event) => update('contactPoint', event.target.value)}
                maxLength={1000}
                disabled={busy}
                placeholder="例：〇〇薬局 個人情報相談窓口　03-0000-0000"
                className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm"
              />
            </label>

            <label className="block text-sm font-medium text-gray-700">
              委託関係の説明
              <textarea
                value={draft.entrustmentText}
                onChange={(event) => update('entrustmentText', event.target.value)}
                rows={3}
                maxLength={2000}
                disabled={busy}
                placeholder="例：予約・連絡システムの運営を外部事業者に委託し、必要な監督を行っています。"
                className="mt-1 block w-full rounded-lg border border-gray-300 p-3 text-sm"
              />
            </label>

            {issues.length > 0 && (
              <p className="text-xs text-amber-700">未入力の項目：{issues.join('、')}</p>
            )}

            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || issues.length > 0 || !selectedAccountId}
                className="min-h-[44px] rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? '保存中...' : '保存する'}
              </button>
              {policy && (
                <span className="text-xs text-gray-500">
                  現在の版：第{policy.policy_version}版（内容ハッシュ {policy.content_hash.slice(0, 12)}…）
                </span>
              )}
            </div>

            <p className="text-xs leading-5 text-gray-500">
              患者が同意した時点の版番号と内容ハッシュはアンケート回答に記録されます。
              文面を変更すると版番号が上がり、以降の同意は新しい版として記録されます。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
