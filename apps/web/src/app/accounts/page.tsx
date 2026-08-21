'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import TestRecipientsSetting from '@/components/accounts/test-recipients-setting'
import AccountSettingsSection from '@/components/accounts/account-settings-section'
import ReorderMode from '@/components/accounts/reorder-mode'
import {
  AccountFormSections,
  emptyAccountFormState,
  type AccountFormState,
} from '@/components/accounts/account-form-fields'
import AccountSetupUrls from '@/components/accounts/account-setup-urls'
import AccountEditModal from '@/components/accounts/account-edit-modal'
import LinkBaseUrlSetting from '@/components/accounts/link-base-url-setting'
import FollowerImportButton from '@/components/accounts/follower-import-button'
import { useAccount } from '@/contexts/account-context'

interface LineAccountListItem {
  id: string
  channelId: string
  name: string
  displayName: string
  pictureUrl: string | null
  basicId: string | null
  isActive: boolean
  pharmacyMode: boolean
  loginChannelId: string | null
  liffId: string | null
  createdAt: string
  updatedAt: string
  stats: {
    friendCount: number
    activeScenarios: number
    messagesThisMonth: number
  }
  ogSiteName: string | null
  ogDefaultDescription: string | null
  ogDefaultImageUrl: string | null
}

const ccPrompts = [
  {
    title: 'LINEアカウント設定確認',
    prompt: `現在登録されているLINEアカウントのチャネル設定を確認してください。
1. 各アカウントのChannel ID・名前・有効/無効ステータスを一覧表示
2. Channel Access TokenとChannel Secretが正しく設定されているか検証
3. LINE Developers Consoleとの設定整合性をチェック
結果をレポートしてください。`,
  },
  {
    title: 'アカウント追加手順',
    prompt: `新しいLINEアカウントを追加する手順をガイドしてください。
1. LINE Developers Consoleでのチャネル作成手順を説明
2. Channel ID、Channel Access Token、Channel Secretの取得方法
3. CRMへの登録手順と初期設定のベストプラクティス
手順を示してください。`,
  },
]

function accountToggleConfirmation(accountName: string, currentActive: boolean): string {
  return currentActive
    ? `「${accountName}」を無効にします。患者からのLINE受信と自動処理が停止します。よろしいですか？`
    : `「${accountName}」を有効にします。LINE受信と自動処理が再開します。よろしいですか？`
}

export default function AccountsPage() {
  const { refreshAccounts, setSelectedAccountId } = useAccount()
  const [accounts, setAccounts] = useState<LineAccountListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showReorder, setShowReorder] = useState(false)
  const [editing, setEditing] = useState<LineAccountListItem | null>(null)
  const [form, setForm] = useState<AccountFormState>(emptyAccountFormState)
  const [createError, setCreateError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [mutatingAccountId, setMutatingAccountId] = useState<string | null>(null)
  const [connectingAccountId, setConnectingAccountId] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [justCreated, setJustCreated] = useState<{
    liffId: string | null
    lineConnected: boolean
    richMenuStatus: 'READY' | 'BLOCKED' | 'UNVERIFIED'
    setupChecks: Array<{ key: string; status: 'BLOCKED' | 'UNVERIFIED'; impact: string; fixHref: string }>
  } | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.lineAccounts.list()
      if (res.success) {
        setAccounts(res.data as unknown as LineAccountListItem[])
      } else {
        setError('アカウント情報の取得に失敗しました')
      }
    } catch {
      setError('APIに接続できませんでした。サーバーが起動しているか確認してください。')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const updateForm = (partial: Partial<AccountFormState>) =>
    setForm((s) => ({ ...s, ...partial }))

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError('')
    if (!form.channelId || !form.name || !form.channelAccessToken || !form.channelSecret) {
      setCreateError('Messaging API の必須項目を入力してください')
      return
    }
    if (!form.loginChannelId.trim() || !form.loginChannelSecret.trim() || !form.liffId.trim()) {
      setCreateError('LINE Login Channel ID・Secret・LIFF IDを入力してください')
      return
    }
    setSubmitting(true)
    try {
      const res = await api.lineAccounts.create({
        channelId: form.channelId.trim(),
        name: form.name.trim(),
        channelAccessToken: form.channelAccessToken.trim(),
        channelSecret: form.channelSecret.trim(),
        loginChannelId: form.loginChannelId.trim() || null,
        loginChannelSecret: form.loginChannelSecret.trim() || null,
        liffId: form.liffId.trim() || null,
        ogSiteName: form.ogSiteName?.trim() || null,
        ogDefaultImageUrl: form.ogDefaultImageUrl?.trim() || null,
        ogDefaultDescription: form.ogDefaultDescription?.trim() || null,
      })
      if (res.success) {
        const accountId = res.data?.id
        let lineConnected = false
        let richMenuStatus: 'READY' | 'BLOCKED' | 'UNVERIFIED' = 'UNVERIFIED'
        let setupChecks: Array<{
          key: string; status: 'BLOCKED' | 'UNVERIFIED'; impact: string; fixHref: string
        }> = []
        if (accountId) {
          try {
            lineConnected = (await api.lineAccounts.connect(accountId)).success
          } catch {
            lineConnected = false
          }
          try {
            const readiness = await api.pharmacyGrowth.readiness(accountId)
            if (readiness.success) {
              richMenuStatus = readiness.data.richMenu.status
              setupChecks = readiness.data.configurationDoctor.checks
                .filter((check): check is typeof check & { status: 'BLOCKED' | 'UNVERIFIED' } =>
                  check.required && check.status !== 'READY')
                .slice(0, 3)
                .map((check) => ({
                  key: check.key, status: check.status, impact: check.impact, fixHref: check.fixHref,
                }))
            }
          } catch {
            richMenuStatus = 'UNVERIFIED'
          }
          await Promise.all([load(), refreshAccounts()])
          setSelectedAccountId(accountId)
        }
        setJustCreated({
          liffId: form.liffId.trim() || null,
          lineConnected,
          richMenuStatus,
          setupChecks,
        })
        setForm(emptyAccountFormState)
        setShowCreate(false)
        if (!accountId) await load()
      } else {
        setCreateError(res.error || '登録に失敗しました')
      }
    } catch {
      setCreateError('登録に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (mutatingAccountId !== null) return
    if (!window.confirm('このLINEアカウントを削除しますか？')) return
    setMutatingAccountId(id)
    setError('')
    try {
      const result = await api.lineAccounts.delete(id)
      if (!result.success) {
        setError('LINEアカウントを削除できませんでした。')
        return
      }
      await load()
    } catch {
      setError('LINEアカウントを削除できませんでした。')
    } finally {
      setMutatingAccountId(null)
    }
  }

  const handleToggle = async (id: string, accountName: string, currentActive: boolean) => {
    if (mutatingAccountId !== null) return
    if (!window.confirm(accountToggleConfirmation(accountName, currentActive))) return
    setMutatingAccountId(id)
    setError('')
    try {
      const result = await api.lineAccounts.update(id, { isActive: !currentActive })
      if (!result.success) {
        setError('LINEアカウントの状態を更新できませんでした。')
        return
      }
      await load()
    } catch {
      setError('LINEアカウントの状態を更新できませんでした。')
    } finally {
      setMutatingAccountId(null)
    }
  }

  const handleConnect = async (accountId: string) => {
    setConnectingAccountId(accountId)
    setConnectionResult((current) => ({ ...current, [accountId]: { ok: false, message: '' } }))
    try {
      const result = await api.lineAccounts.connect(accountId)
      setConnectionResult((current) => ({
        ...current,
        [accountId]: {
          ok: result.success,
          message: result.success
            ? 'LINE接続とWebhook設定を確認しました'
            : result.error || 'LINE接続を確認できませんでした',
        },
      }))
    } catch {
      setConnectionResult((current) => ({
        ...current,
        [accountId]: { ok: false, message: 'LINE接続に失敗しました。設定を確認して再実行してください' },
      }))
    } finally {
      setConnectingAccountId(null)
    }
  }

  return (
    <div>
      <Header
        title="LINEアカウント管理"
        description="マルチアカウント設定"
        action={
          <div className="flex gap-2">
            <button
              onClick={() => setShowReorder(true)}
              className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50"
            >
              並び替えモード
            </button>
            {!loading && !accounts.some((account) => account.pharmacyMode) && (
              <button
                onClick={() => {
                  const next = !showCreate
                  setShowCreate(next)
                  if (!next) {
                    setForm(emptyAccountFormState)
                    setCreateError('')
                  }
                }}
                className="px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ backgroundColor: '#06C755' }}
              >
                {showCreate ? 'キャンセル' : '+ アカウント追加'}
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {justCreated && (
        <div aria-live="polite" className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-semibold text-green-800 mb-2">
            ✓ アカウントを登録しました
          </p>
          <p className="text-xs text-green-700 mb-3">
            次に LINE Developers Console で以下の URL を貼り付けてください。
          </p>
          <p className={`mb-3 text-xs ${justCreated.lineConnected ? 'text-green-700' : 'text-amber-700'}`}>
            LINE接続: {justCreated.lineConnected ? 'Webhookまで自動設定済み' : '要確認（下のアカウント欄から再実行できます）'}
          </p>
          <AccountSetupUrls liffId={justCreated.liffId} heading="登録すべき URL" />
          <div className="mt-3 rounded-lg bg-white/70 p-3 text-xs text-green-900">
            <p className="font-semibold">初期リッチメニュー: {justCreated.richMenuStatus}</p>
            {justCreated.setupChecks.length > 0 && <ul className="mt-2 space-y-2">
              {justCreated.setupChecks.map((check) => <li key={check.key}>
                <span>{check.status}: {check.impact}</span>{' '}
                <Link href={check.fixHref} className="inline-flex min-h-11 items-center underline">設定を開く</Link>
              </li>)}
            </ul>}
            <Link href="/rich-menus" className="mt-2 inline-flex min-h-11 items-center font-semibold underline">
              {justCreated.richMenuStatus === 'READY'
                ? '初期設定を確認'
                : justCreated.richMenuStatus === 'UNVERIFIED' ? '初期設定を再開' : '初期設定を開始'}
            </Link>
          </div>
          <button
            onClick={() => setJustCreated(null)}
            className="mt-3 text-xs text-green-700 underline"
          >
            閉じる
          </button>
        </div>
      )}

      {showCreate && !accounts.some((account) => account.pharmacyMode) && (
        <form onSubmit={handleCreate} className="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              アカウント名 <span className="text-red-500">*</span>
            </label>
            <input
              value={form.name}
              onChange={(e) => updateForm({ name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="メインアカウント"
              required
            />
          </div>

          <AccountFormSections
            state={form}
            update={updateForm}
            showMessagingRequired={true}
            showLoginRequired={true}
            defaultOpen={{ messaging: true, login: true, liff: true }}
          />

          <AccountSetupUrls liffId={form.liffId.trim() || null} />

          {createError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
              {createError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {submitting ? '登録中...' : '登録'}
          </button>
        </form>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : error ? null : accounts.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          <p className="mb-2">LINEアカウントが登録されていません</p>
          <p className="text-xs text-gray-300">LINE Developers Console からChannel情報を取得して登録してください</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {accounts.map((account) => (
            <div key={account.id} className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  {account.pictureUrl ? (
                    <img
                      src={account.pictureUrl}
                      alt={account.displayName}
                      className="w-10 h-10 rounded-lg object-cover"
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                      style={{ backgroundColor: account.isActive ? '#06C755' : '#9CA3AF' }}
                    >
                      {account.displayName?.charAt(0) || 'L'}
                    </div>
                  )}
                  <div>
                    <h3 className="text-sm font-bold text-gray-900">{account.displayName}</h3>
                    <p className="text-xs text-gray-400 font-mono">
                      {account.basicId ? `${account.basicId} · ` : ''}Channel: {account.channelId}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleToggle(account.id, account.displayName, account.isActive)}
                  disabled={mutatingAccountId !== null}
                  className={`text-xs px-2 py-0.5 rounded-full disabled:opacity-50 ${account.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                >
                  {mutatingAccountId === account.id ? '更新中…' : account.isActive ? '有効' : '無効'}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-4 py-3 border-t border-b border-gray-100">
                <div className="text-center">
                  <p className="text-lg font-bold text-gray-900">{account.stats.friendCount}</p>
                  <p className="text-xs text-gray-400">友だち</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-blue-600">{account.stats.activeScenarios}</p>
                  <p className="text-xs text-gray-400">配信中</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-green-600">{account.stats.messagesThisMonth}</p>
                  <p className="text-xs text-gray-400">今月送信</p>
                </div>
              </div>

              {/* Login/LIFF status badges — at-a-glance signal that an account
                  is fully wired. Important because SQL-only setup historically
                  left rows half-configured (Login/LIFF blank). */}
              <div className="flex gap-2 mb-3 text-[11px]">
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    account.loginChannelId
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  Login: {account.loginChannelId ? '設定済' : '未設定'}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    account.liffId
                      ? 'bg-purple-50 text-purple-700'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  LIFF: {account.liffId ? '設定済' : '未設定'}
                </span>
              </div>

              <AccountSettingsSection
                accountId={account.id}
                initialCountry={(account as { country?: string | null }).country ?? null}
                initialRole={(account as { role?: string | null }).role ?? null}
                onUpdated={load}
              />
              <TestRecipientsSetting accountId={account.id} />
              <FollowerImportButton accountId={account.id} onImported={load} />

              <div className="mt-3 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => handleConnect(account.id)}
                  disabled={connectingAccountId === account.id}
                  className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  {connectingAccountId === account.id ? 'LINE接続を確認中…' : 'LINE接続を確認・更新'}
                </button>
                {connectionResult[account.id]?.message && (
                  <p
                    role="status"
                    className={`mt-1 text-xs ${connectionResult[account.id].ok ? 'text-green-700' : 'text-red-600'}`}
                  >
                    {connectionResult[account.id].message}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                <p className="text-xs text-gray-400">
                  登録: {new Date(account.createdAt).toLocaleDateString('ja-JP')}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(account)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    編集
                  </button>
                  {!account.pharmacyMode && (
                     <button
                       onClick={() => handleDelete(account.id)}
                       disabled={mutatingAccountId !== null}
                       className="text-red-500 hover:text-red-700 text-xs disabled:opacity-50"
                     >
                      削除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!accounts.some((account) => account.pharmacyMode) && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">グローバル設定</h2>
          <LinkBaseUrlSetting />
        </div>
      )}
      <CcPromptButton prompts={ccPrompts} />
      {showReorder && (
        <ReorderMode
          accounts={accounts.map((a) => ({
            id: a.id,
            name: a.name,
            displayName: a.displayName,
            country: (a as { country?: string | null }).country ?? null,
          }))}
          onClose={() => setShowReorder(false)}
          onSaved={load}
        />
      )}
      {editing && (
        <AccountEditModal
          accountId={editing.id}
          initialName={editing.name}
          initialChannelId={editing.channelId}
          initialLoginChannelId={editing.loginChannelId}
          initialLiffId={editing.liffId}
          initialOgSiteName={editing.ogSiteName}
          initialOgDefaultDescription={editing.ogDefaultDescription}
          initialOgDefaultImageUrl={editing.ogDefaultImageUrl}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}
