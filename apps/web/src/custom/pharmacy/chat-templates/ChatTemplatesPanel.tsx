'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import { chatTemplateApi, type PharmacyChatTemplate } from './api'

const STATUS_LABELS: Record<PharmacyChatTemplate['status'], string> = {
  draft: '下書き',
  approved: '承認済み',
  archived: 'アーカイブ済み',
}

export function templateFormError(title: string, body: string): string | null {
  if (title.trim().length < 1 || title.trim().length > 80) {
    return '定型文の名前は1〜80文字で入力してください。'
  }
  if (body.trim().length < 1 || body.trim().length > 500) {
    return '本文は1〜500文字で入力してください。'
  }
  if (/\{\{|\}\}|\$\{/.test(title) || /\{\{|\}\}|\$\{/.test(body)) {
    return '患者名などの差し込み記号は使えません。'
  }
  return null
}

export default function ChatTemplatesPanel({
  accountId,
  canMutate,
}: {
  accountId: string
  canMutate: boolean
}) {
  const [templates, setTemplates] = useState<PharmacyChatTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [mutatingId, setMutatingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const accountRef = useRef(accountId)
  accountRef.current = accountId

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await chatTemplateApi.list(accountId)
      if (accountRef.current !== accountId) return
      setTemplates(response.templates)
      setUnavailable(false)
    } catch (cause) {
      if (accountRef.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 503) {
        setUnavailable(true)
      } else {
        setError('定型文を取得できませんでした。再読み込みしてください。')
      }
    } finally {
      if (accountRef.current === accountId) setLoading(false)
    }
  }, [accountId])

  useEffect(() => { void load() }, [load])

  const editing = editingId ? templates.find((t) => t.id === editingId) ?? null : null
  const formError = templateFormError(title, body)

  function startCreate() {
    setEditingId(null)
    setTitle('')
    setBody('')
    setMessage('')
    setError('')
  }

  function startEdit(template: PharmacyChatTemplate) {
    setEditingId(template.id)
    setTitle(template.title)
    setBody(template.body)
    setMessage('')
    setError('')
  }

  async function run(action: () => Promise<{ template: PharmacyChatTemplate }>, key: string, done: string) {
    if (mutatingId) return
    setMutatingId(key)
    setError('')
    setMessage('')
    try {
      await action()
      if (accountRef.current !== accountId) return
      setMessage(done)
      setEditingId(null)
      setTitle('')
      setBody('')
      await load()
    } catch (cause) {
      if (accountRef.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        setError('別の更新がありました。最新の定型文を再取得しました。')
        await load()
      } else {
        setError('定型文を処理できませんでした。入力内容を確認してください。')
      }
    } finally {
      if (accountRef.current === accountId) setMutatingId(null)
    }
  }

  async function save() {
    if (formError || mutatingId) return
    if (editing) {
      if (editing.status === 'approved' && !window.confirm(
        '承認済みの定型文を変更すると下書きに戻り、再度の承認が必要です。変更しますか？',
      )) return
      await run(() => chatTemplateApi.update(accountId, editing.id, {
        title: title.trim(),
        body: body.trim(),
        expectedVersion: editing.version,
      }), `update-${editing.id}`, '定型文を更新しました。利用には再度の承認が必要です。')
      return
    }
    await run(() => chatTemplateApi.create(accountId, {
      title: title.trim(),
      body: body.trim(),
    }), 'create', '定型文を下書きとして保存しました。')
  }

  async function approve(template: PharmacyChatTemplate) {
    if (!canMutate || mutatingId) return
    await run(
      () => chatTemplateApi.approve(accountId, template.id, template.version),
      `approve-${template.id}`,
      '定型文を承認しました。個別チャットで挿入できるようになりました。',
    )
  }

  async function archive(template: PharmacyChatTemplate) {
    if (mutatingId) return
    if (!window.confirm(`定型文「${template.title}」をアーカイブしますか？個別チャットで選べなくなります。`)) return
    await run(
      () => chatTemplateApi.archive(accountId, template.id, template.version),
      `archive-${template.id}`,
      '定型文をアーカイブしました。',
    )
  }

  if (unavailable) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="chat-templates-title">
        <h2 id="chat-templates-title" className="font-semibold">チャット定型文</h2>
        <p className="mt-2 text-sm text-gray-600">この環境では定型文をまだ利用できません。機能の準備が整うまでお待ちください。</p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5" aria-labelledby="chat-templates-title">
      <h2 id="chat-templates-title" className="font-semibold">チャット定型文</h2>
      <p className="mt-1 text-sm text-gray-600">
        個別チャットで挿入できる定型文です。利用にはオーナーまたは管理者の承認が必要です。
        患者名・薬名・病名などの個人情報は書かないでください。
      </p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {loading ? <p className="py-8 text-center text-sm text-gray-500">定型文を読み込み中...</p> : (
        <>
          <ul className="mt-4 divide-y divide-gray-200">
            {templates.map((template) => (
              <li key={template.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {template.title}
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${template.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                        {STATUS_LABELS[template.status]}
                      </span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600">{template.body}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => startEdit(template)}
                      disabled={mutatingId !== null}
                      className="min-h-11 rounded-lg border border-gray-300 px-3 py-1 text-sm text-gray-700 disabled:opacity-50">
                      編集
                    </button>
                    {template.status === 'draft' && canMutate && (
                      <button type="button" onClick={() => void approve(template)}
                        disabled={mutatingId !== null}
                        className="min-h-11 rounded-lg bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
                        {mutatingId === `approve-${template.id}` ? '承認中…' : '承認する'}
                      </button>
                    )}
                    <button type="button" onClick={() => void archive(template)}
                      disabled={mutatingId !== null}
                      className="min-h-11 rounded-lg border border-red-300 px-3 py-1 text-sm text-red-700 disabled:opacity-50">
                      {mutatingId === `archive-${template.id}` ? '処理中…' : 'アーカイブ'}
                    </button>
                  </div>
                </div>
                {editingId === template.id && (
                  <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <label className="block text-sm font-medium">
                      定型文の名前
                      <input type="text" value={title} maxLength={80}
                        onChange={(event) => setTitle(event.target.value)}
                        className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" />
                    </label>
                    <label className="mt-3 block text-sm font-medium">
                      本文（500文字以内）
                      <textarea value={body} rows={3} maxLength={500}
                        onChange={(event) => setBody(event.target.value)}
                        className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
                    </label>
                    <div className="mt-3 flex items-center gap-3">
                      <button type="button" onClick={() => void save()}
                        disabled={Boolean(formError) || mutatingId !== null}
                        className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                        {mutatingId === `update-${template.id}` ? '保存中…' : '変更を保存'}
                      </button>
                      <button type="button" onClick={startCreate}
                        className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700">
                        編集をやめる
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {templates.length === 0 && (
              <li className="py-3 text-sm text-gray-500">まだ定型文がありません。</li>
            )}
          </ul>
          {!editing && (
            <div className="mt-4 rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-medium">新しい定型文</h3>
              <label className="mt-2 block text-sm font-medium">
                定型文の名前
                <input type="text" value={title} maxLength={80}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例: 受付確認"
                  className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" />
              </label>
              <label className="mt-3 block text-sm font-medium">
                本文（500文字以内）
                <textarea value={body} rows={3} maxLength={500}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="例: 処方せんを受け付けました。準備ができ次第ご連絡します。"
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
              </label>
              {formError && (title || body) && (
                <p role="alert" className="mt-2 text-sm text-red-700">{formError}</p>
              )}
              <button type="button" onClick={() => void save()}
                disabled={Boolean(formError) || mutatingId !== null}
                className="mt-3 min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {mutatingId === 'create' ? '保存中…' : '下書きとして保存'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
