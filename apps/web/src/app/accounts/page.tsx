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

interface LineAccountListItem {
  id: string
  channelId: string
  name: string
  displayName: string
  pictureUrl: string | null
  basicId: string | null
  isActive: boolean
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

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<LineAccountListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showReorder, setShowReorder] = useState(false)
  const [editing, setEditing] = useState<LineAccountListItem | null>(null)
  const [form, setForm] = useState<AccountFormState>(emptyAccountFormState)
  const [createError, setCreateError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [preparingRichMenu, setPreparingRichMenu] = useState(false)
  const [justCreated, setJustCreated] = useState<{
    accountId: string
    liffId: string | null
    richMenuStatus: 'prepared' | 'configuration_required' | 'failed'
    richMenuGroupId: string | null
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
        let richMenuStatus: 'prepared' | 'configuration_required' | 'failed' = 'failed'
        let richMenuGroupId: string | null = null
        if (accountId) {
          try {
            const menu = await api.richMenuGroups.preparePharmacy(accountId, { initial: true })
            if (menu.success) {
              richMenuStatus = menu.data.status === 'prepared' || menu.data.status === 'already_prepared'
                ? 'prepared'
                : 'configuration_required'
              richMenuGroupId = menu.data.group?.id ?? null
            } else if (menu.error?.toLowerCase().includes('liff')) {
              richMenuStatus = 'configuration_required'
            }
          } catch {
            richMenuStatus = form.liffId.trim() ? 'failed' : 'configuration_required'
          }
        }
        setJustCreated({
          accountId: accountId ?? '',
          liffId: form.liffId.trim() || null,
          richMenuStatus,
          richMenuGroupId,
        })
        setForm(emptyAccountFormState)
        setShowCreate(false)
        load()
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
    if (!confirm('このLINEアカウントを削除しますか？')) return
    await api.lineAccounts.delete(id)
    load()
  }

  const handleToggle = async (id: string, currentActive: boolean) => {
    await api.lineAccounts.update(id, { isActive: !currentActive })
    load()
  }

  const prepareInitialRichMenu = async () => {
    if (!justCreated?.accountId) return
    setPreparingRichMenu(true)
    try {
      const menu = await api.richMenuGroups.preparePharmacy(justCreated.accountId, { initial: true })
      const menuError = menu.success ? '' : menu.error ?? ''
      setJustCreated((current) => current ? {
        ...current,
        richMenuStatus: menu.success && (menu.data.status === 'prepared' || menu.data.status === 'already_prepared')
          ? 'prepared'
          : menuError.toLowerCase().includes('liff') ? 'configuration_required' : 'failed',
        richMenuGroupId: menu.success ? menu.data.group?.id ?? current.richMenuGroupId : current.richMenuGroupId,
      } : current)
    } catch {
      setJustCreated((current) => current ? { ...current, richMenuStatus: 'failed' } : current)
    } finally {
      setPreparingRichMenu(false)
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
          </div>
        }
      />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {justCreated && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-semibold text-green-800 mb-2">
            ✓ アカウントを登録しました
          </p>
          <p className="text-xs text-green-700 mb-3">
            次に LINE Developers Console で以下の URL を貼り付けてください。
          </p>
          <AccountSetupUrls liffId={justCreated.liffId} heading="登録すべき URL" />
          <p className="mt-3 text-xs text-green-700">
            初期リッチメニュー:{' '}
            {justCreated.richMenuStatus === 'prepared' ? (
              justCreated.richMenuGroupId ? (
                <Link href={`/rich-menus/edit?id=${justCreated.richMenuGroupId}`} className="underline">下書きを確認</Link>
              ) : '準備済み'
            ) : justCreated.richMenuStatus === 'configuration_required' ? (
              'LIFF ID 登録後に準備できます'
            ) : (
              '準備に失敗しました。リッチメニュー画面から再実行してください'
            )}
          </p>
          {justCreated.richMenuStatus !== 'prepared' && (
            <button
              type="button"
              onClick={prepareInitialRichMenu}
              disabled={preparingRichMenu || !justCreated.liffId}
              className="mt-2 text-xs text-green-800 underline disabled:no-underline disabled:opacity-50"
            >
              {preparingRichMenu ? '初期メニューを準備中...' : '初期メニューを再実行'}
            </button>
          )}
          <button
            onClick={() => setJustCreated(null)}
            className="mt-3 text-xs text-green-700 underline"
          >
            閉じる
          </button>
        </div>
      )}

      {showCreate && (
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
      ) : accounts.length === 0 ? (
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
                  onClick={() => handleToggle(account.id, account.isActive)}
                  className={`text-xs px-2 py-0.5 rounded-full ${account.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                >
                  {account.isActive ? '有効' : '無効'}
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
                  <button
                    onClick={() => handleDelete(account.id)}
                    className="text-red-500 hover:text-red-700 text-xs"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">グローバル設定</h2>
        <LinkBaseUrlSetting />
      </div>
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
