'use client'

import Link from 'next/link'
import { useRef, useState, type FormEvent } from 'react'
import {
  platformAdminApi,
  type PlatformTenantProvisioningResult,
} from '@/lib/platform-admin-api'

const steps = [
  'テナントと初期管理者',
  'Messaging API',
  'LINE Login / LIFF',
  '入力内容の確認',
  '設定完了',
]

const inputClass = 'mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2'

export default function PlatformAdminTenantNewPage() {
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<PlatformTenantProvisioningResult | null>(null)
  const idempotencyKey = useRef<string | null>(null)

  const [tenantName, setTenantName] = useState('')
  const [adminLoginId, setAdminLoginId] = useState('')
  const [adminDisplayName, setAdminDisplayName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [channelId, setChannelId] = useState('')
  const [lineDisplayName, setLineDisplayName] = useState('')
  const [channelAccessToken, setChannelAccessToken] = useState('')
  const [channelSecret, setChannelSecret] = useState('')
  const [loginChannelId, setLoginChannelId] = useState('')
  const [loginChannelSecret, setLoginChannelSecret] = useState('')
  const [liffId, setLiffId] = useState('')

  function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (step === 2 && !liffId.startsWith(`${loginChannelId}-`)) {
      setError('LIFF IDはLINE LoginチャネルIDから始まる値を入力してください。')
      return
    }
    setStep((current) => current + 1)
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setError('')
    idempotencyKey.current ??= crypto.randomUUID()
    try {
      const response = await platformAdminApi.provisionTenant({
        tenantName: tenantName.trim(),
        admin: {
          loginId: adminLoginId.trim(),
          displayName: adminDisplayName.trim(),
          email: adminEmail.trim() || null,
          temporaryPassword,
        },
        line: {
          channelId: channelId.trim(),
          displayName: lineDisplayName.trim(),
          channelAccessToken: channelAccessToken.trim(),
          channelSecret: channelSecret.trim(),
          loginChannelId: loginChannelId.trim(),
          loginChannelSecret: loginChannelSecret.trim(),
          liffId: liffId.trim(),
        },
      }, idempotencyKey.current)
      setResult(response.data)
      setTemporaryPassword('')
      setChannelAccessToken('')
      setChannelSecret('')
      setLoginChannelSecret('')
      setStep(4)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'テナントを設定できませんでした。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-purple-800">新規テナント設定ガイド</p>
          <h1 className="text-2xl font-bold">{steps[step]}</h1>
        </div>
        <Link href="/platform-admin/tenants" className="inline-flex min-h-11 items-center text-sm text-purple-800 underline">テナント一覧へ</Link>
      </div>

      <ol aria-label="設定手順" className="mb-6 grid grid-cols-5 gap-1 text-center text-xs">
        {steps.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} className={index <= step ? 'font-semibold text-purple-800' : 'text-gray-400'}>
            <span className="block">{index + 1}</span>{label}
          </li>
        ))}
      </ol>

      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {step < 3 && (
        <form onSubmit={next} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          {step === 0 && <>
            <p className="text-sm text-gray-600">薬局テナントと、最初にログインする管理者を設定します。</p>
            <label className="block text-sm font-medium">薬局・法人名
              <input required maxLength={120} value={tenantName} onChange={(event) => setTenantName(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">初期管理者ログインID
              <input required pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" autoComplete="off" value={adminLoginId} onChange={(event) => setAdminLoginId(event.target.value)} className={inputClass} />
              <span className="mt-1 block text-xs text-gray-500">半角英数字で始まる3〜64文字（記号は . _ -）</span>
            </label>
            <label className="block text-sm font-medium">初期管理者名
              <input required maxLength={120} value={adminDisplayName} onChange={(event) => setAdminDisplayName(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">メールアドレス（任意）
              <input type="email" maxLength={254} value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">初期パスワード
              <input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} className={inputClass} />
              <span className="mt-1 block text-xs text-gray-500">12〜128文字。初回ログイン後に変更が必要です。</span>
            </label>
          </>}

          {step === 1 && <>
            <p className="text-sm text-gray-600">LINE DevelopersのMessaging APIチャネルから転記してください。</p>
            <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm text-purple-800 underline">LINE Developersコンソールを開く</a>
            <label className="block text-sm font-medium">Messaging APIチャネルID
              <input required inputMode="numeric" pattern="[0-9]{6,32}" value={channelId} onChange={(event) => setChannelId(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">LINE公式アカウント名
              <input required maxLength={120} value={lineDisplayName} onChange={(event) => setLineDisplayName(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">チャネルアクセストークン
              <input required type="password" minLength={32} maxLength={2048} autoComplete="off" value={channelAccessToken} onChange={(event) => setChannelAccessToken(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">チャネルシークレット
              <input required type="password" pattern="[A-Fa-f0-9]{32}" autoComplete="off" value={channelSecret} onChange={(event) => setChannelSecret(event.target.value)} className={inputClass} />
            </label>
          </>}

          {step === 2 && <>
            <p className="text-sm text-gray-600">LINE Loginチャネルと、そのチャネルに追加したLIFFアプリの値を転記してください。</p>
            <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm text-purple-800 underline">LINE Developersコンソールを開く</a>
            <label className="block text-sm font-medium">LINE LoginチャネルID
              <input required inputMode="numeric" pattern="[0-9]{6,32}" value={loginChannelId} onChange={(event) => setLoginChannelId(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">LINE Loginチャネルシークレット
              <input required type="password" pattern="[A-Fa-f0-9]{32}" autoComplete="off" value={loginChannelSecret} onChange={(event) => setLoginChannelSecret(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">LIFF ID
              <input required pattern="[0-9]{6,32}-[A-Za-z0-9_-]{8,64}" value={liffId} onChange={(event) => setLiffId(event.target.value)} className={inputClass} />
            </label>
          </>}

          <div className="flex justify-between gap-3 pt-2">
            <button type="button" disabled={step === 0} onClick={() => { setError(''); setStep((current) => current - 1) }} className="min-h-11 rounded-lg border border-gray-300 px-4 disabled:opacity-40">戻る</button>
            <button type="submit" className="min-h-11 rounded-lg bg-purple-800 px-5 font-semibold text-white">次へ</button>
          </div>
        </form>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm text-gray-600">登録後にLINE接続確認とWebhook URL設定を行います。リッチメニューは自動公開しません。</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">薬局・法人名</dt><dd className="font-medium">{tenantName}</dd></div>
            <div><dt className="text-gray-500">初期管理者</dt><dd className="font-medium">{adminDisplayName}（{adminLoginId}）</dd></div>
            <div><dt className="text-gray-500">Messaging API</dt><dd className="font-medium">{lineDisplayName}（{channelId}）</dd></div>
            <div><dt className="text-gray-500">LINE Login / LIFF</dt><dd className="font-medium">{loginChannelId} / {liffId}</dd></div>
            <div><dt className="text-gray-500">秘密情報</dt><dd className="font-medium">入力済み（画面には再表示しません）</dd></div>
          </dl>
          <div className="flex justify-between gap-3 pt-2">
            <button type="button" onClick={() => setStep(2)} className="min-h-11 rounded-lg border border-gray-300 px-4">戻る</button>
            <button type="button" disabled={submitting} onClick={submit} className="min-h-11 rounded-lg bg-purple-800 px-5 font-semibold text-white disabled:opacity-50">{submitting ? '設定中...' : 'この内容で設定する'}</button>
          </div>
        </section>
      )}

      {step === 4 && result && (
        <section role="status" className="space-y-4 rounded-xl border border-green-200 bg-green-50 p-5">
          <p className="font-semibold text-green-900">テナント設定が完了しました。</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-600">テナントコード</dt><dd className="font-mono text-lg font-bold">{result.tenantCode}</dd></div>
            <div><dt className="text-gray-600">管理者ログインID</dt><dd className="font-mono">{result.adminLoginId}</dd></div>
            <div><dt className="text-gray-600">LINE接続確認</dt><dd>{result.line.tokenValidated ? '成功' : '未確認'}</dd></div>
            <div><dt className="text-gray-600">Webhook自動設定</dt><dd>{result.line.webhookConfigured ? '成功' : '要確認'}</dd></div>
          </dl>
          {!result.line.webhookConfigured && <p role="alert" className="rounded-lg bg-amber-100 p-3 text-sm text-amber-900">LINE DevelopersでWebhook URLを設定し、「Webhookの利用」を有効にしてください。</p>}
          <div className="text-sm">
            <p><a href={result.urls.admin} target="_blank" rel="noreferrer" className="text-purple-800 underline">管理画面を開く</a></p>
            <p className="break-all">Webhook URL: <code>{result.urls.webhook}</code></p>
            <p className="break-all">LIFF endpoint: <code>{result.urls.liffEndpoint}</code></p>
          </div>
          <Link href={`/platform-admin/tenants/detail?id=${encodeURIComponent(result.tenantId)}`} className="inline-flex min-h-11 items-center rounded-lg bg-purple-800 px-5 font-semibold text-white">テナント詳細を確認</Link>
        </section>
      )}
    </div>
  )
}
