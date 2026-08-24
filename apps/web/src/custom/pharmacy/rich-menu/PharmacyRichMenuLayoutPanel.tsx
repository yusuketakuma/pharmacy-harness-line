'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type PharmacyRichMenuVersionDiff } from '@/lib/api'
import { ApplyToTagModal } from '@/components/rich-menus/apply-to-tag-modal'
import { richMenuAreaStyle } from './preview-geometry'
import { readinessStatusLabel } from '../growth-loop/FeatureSettingsPage'

export const PHARMACY_RICH_MENU_LABELS: Record<string, string> = {
  'prescription-send': '処方せん事前送信',
  'prescription-history': '受付状況',
  'medication-followup': '服薬後フォロー',
  'manual-chat': '薬局へ相談',
  'pharmacy-info': '薬局情報',
}

export function canMutatePharmacyRichMenu(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

type Layout = Extract<
  Awaited<ReturnType<typeof api.richMenuGroups.pharmacyLayout>>,
  { success: true }
>['data']

type Lifecycle = Extract<
  Awaited<ReturnType<typeof api.richMenuGroups.pharmacyLifecycle>>,
  { success: true }
>['data']

type Version = Extract<
  Awaited<ReturnType<typeof api.richMenuGroups.pharmacyVersions>>,
  { success: true }
>['data'][number]

type PreviewArea = {
  id: string
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch'
}

type SlotDiff = Extract<PharmacyRichMenuVersionDiff, { status: 'VERIFIED' }>['slots'][number]

export function pharmacyRichMenuDiffLabel(diff: SlotDiff): string {
  const slot = (diff.draftIndex ?? diff.currentIndex ?? 0) + 1
  if (diff.kind === 'moved') return `枠${slot}: 枠${(diff.currentIndex ?? 0) + 1}から移動`
  const label = {
    same: '同一', added: '追加', removed: '削除',
    action_changed: 'action変更', image_changed: '画像変更',
  }[diff.kind]
  return `枠${slot}: ${label}`
}

const DIFF_UNVERIFIED_LABELS: Record<string, string> = {
  CURRENT_DEFAULT_EVIDENCE_STALE: 'LINEの現在表示を24時間以内に確認できていません。状態を再確認してください。',
  CURRENT_DEFAULT_VERSION_MISSING: '確認済みの現在表示に対応する保存versionがありません。',
  CURRENT_DEFAULT_MANIFEST_UNAVAILABLE: '確認済みの現在表示のtap領域を取得できません。',
}

type Readiness = Extract<
  Awaited<ReturnType<typeof api.pharmacyGrowth.readiness>>,
  { success: true }
>['data']['richMenu']

const READINESS_LABELS: Array<[keyof Omit<Readiness, 'status' | 'capabilityEnabled'>, string]> = [
  ['layoutConfigured', '並び順の保存'],
  ['savedVersionAvailable', '保存済み画像version'],
  ['catalogVersionCurrent', '現行画像catalogのversion'],
  ['publishedVersionAvailable', 'LINE登録済みversion'],
  ['currentDefaultRecorded', '初期表示の設定'],
]

const ACTION_DIAGNOSTIC_LABELS: Record<string, string> = {
  ACTION_COUNT_INVALID: 'メニューの枠数が正しくありません。',
  ACTION_BOUNDS_INVALID: '画像とタップ領域が一致しません。',
  ACTION_TYPE_INVALID: 'タップ時の動作種別が正しくありません。',
  ACTION_URI_INVALID: 'リンク先が正しくありません。',
  ACTION_MESSAGE_INVALID: '相談メッセージが承認済み文言と一致しません。',
}

export function pharmacyRichMenuReadinessMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== 'object') return null
  const reasonCodes = (error.data as { reasonCodes?: unknown }).reasonCodes
  if (!Array.isArray(reasonCodes)) return null
  const messages = reasonCodes.flatMap((code) =>
    typeof code === 'string' && ACTION_DIAGNOSTIC_LABELS[code]
      ? [ACTION_DIAGNOSTIC_LABELS[code]]
      : [],
  )
  return messages.length > 0 ? [...new Set(messages)].join('') : null
}

export function movePharmacyRichMenuAction(
  order: readonly string[], key: string, direction: -1 | 1,
): string[] {
  const from = order.indexOf(key)
  const to = from + direction
  if (from < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

export function PharmacyRichMenuLayoutPanel({ accountId }: { accountId: string }) {
  const [staffRole, setStaffRole] = useState<string | null>()
  const [layout, setLayout] = useState<Layout | null>(null)
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [versions, setVersions] = useState<Version[]>([])
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [versionName, setVersionName] = useState('')
  const [preview, setPreview] = useState<{ version: Version; checks: PreviewArea[] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ groupId: string; data: PharmacyRichMenuVersionDiff } | null>(null)
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const [switchTarget, setSwitchTarget] = useState<Version | null>(null)
  const [switchIntent, setSwitchIntent] = useState<'switch' | 'rollback'>('switch')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lifecycleSaving, setLifecycleSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState<string | null>(null)
  const [resumable, setResumable] = useState<string | null>(null)
  const [resuming, setResuming] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const accountRef = useRef(accountId)
  const previewCloseRef = useRef<HTMLButtonElement>(null)
  accountRef.current = accountId

  useEffect(() => {
    try {
      setStaffRole(localStorage.getItem('lh_staff_role'))
    } catch {
      setStaffRole(null)
    }
  }, [])

  const canMutate = canMutatePharmacyRichMenu(staffRole)

  useEffect(() => {
    if (preview) previewCloseRef.current?.focus()
  }, [preview])

  const load = useCallback(async () => {
    const requestedAccountId = accountId
    setLoading(true)
    setError('')
    try {
      const [response, lifecycleResponse, versionsResponse, readinessResponse] = await Promise.all([
        api.richMenuGroups.pharmacyLayout(requestedAccountId),
        api.richMenuGroups.pharmacyLifecycle(requestedAccountId),
        api.richMenuGroups.pharmacyVersions(requestedAccountId),
        api.pharmacyGrowth.readiness(requestedAccountId),
      ])
      if (accountRef.current !== requestedAccountId) return
      if (!response.success || !lifecycleResponse.success || !versionsResponse.success || !readinessResponse.success) {
        throw new Error('missing pharmacy rich-menu state')
      }
      setLayout(response.data)
      setLifecycle(lifecycleResponse.data)
      setOrder(response.data.preferredOrder)
      setVersions(versionsResponse.data)
      setReadiness(readinessResponse.data.richMenu)
    } catch {
      if (accountRef.current === requestedAccountId) setError('薬局リッチメニュー設定を取得できませんでした。')
    } finally {
      if (accountRef.current === requestedAccountId) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    setLayout(null)
    setLifecycle(null)
    setOrder([])
    setVersions([])
    setReadiness(null)
    setVersionName('')
    setPreview(null)
    setPreviewLoading(null)
    setDiff(null)
    setDiffLoading(null)
    setSwitchTarget(null)
    setSwitchIntent('switch')
    setSaving(false)
    setLifecycleSaving(false)
    setCreating(false)
    setRenaming(null)
    setDeleting(null)
    setPublishing(null)
    setReconciling(null)
    setResumable(null)
    setResuming(null)
    setMessage('')
    void load()
  }, [load])

  const dirty = Boolean(layout) && (layout?.revision === 0 || order.join() !== layout?.preferredOrder.join())

  async function openPreview(version: Version) {
    const requestedAccountId = accountId
    setPreviewLoading(version.groupId)
    setError('')
    try {
      const response = await api.richMenuGroups.getForAccount(version.groupId, requestedAccountId)
      if (accountRef.current !== requestedAccountId) return
      if (!response.success || response.data.id !== version.groupId ||
          response.data.accountId !== requestedAccountId) throw new Error('version scope mismatch')
      const page = response.data.pages.find((item) => item.id === response.data.defaultPageId)
        ?? response.data.pages[0]
      if (!page || page.imageR2Key !== version.imageR2Key) throw new Error('version image mismatch')
      const imageHeight = version.menuSize === 'large' ? 1686 : 843
      const validActions = new Set(['uri', 'message', 'postback', 'richmenuswitch'])
      if (page.areas.some((check) => !validActions.has(check.actionType) ||
          ![check.boundsX, check.boundsY, check.boundsWidth, check.boundsHeight].every(Number.isFinite) ||
          check.boundsX < 0 || check.boundsY < 0 || check.boundsWidth <= 0 || check.boundsHeight <= 0 ||
          check.boundsX + check.boundsWidth > 2500 || check.boundsY + check.boundsHeight > imageHeight)) {
        throw new Error('version action bounds mismatch')
      }
      setPreview({ version, checks: page.areas })
    } catch {
      if (accountRef.current === requestedAccountId) {
        setError('保存画像とtap領域を確認できませんでした。versionの状態を再取得してください。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setPreviewLoading(null)
    }
  }

  async function loadDiff(version: Version) {
    const requestedAccountId = accountId
    setDiffLoading(version.groupId)
    setError('')
    try {
      const response = await api.richMenuGroups.pharmacyVersionDiff(
        requestedAccountId, version.groupId,
      )
      if (accountRef.current !== requestedAccountId) return
      if (!response.success || response.data.accountId !== requestedAccountId) {
        throw new Error('version diff scope mismatch')
      }
      setDiff({ groupId: version.groupId, data: response.data })
    } catch {
      if (accountRef.current === requestedAccountId) {
        setError('公開中メニューとの差分を確認できませんでした。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setDiffLoading(null)
    }
  }

  async function save() {
    if (!layout || !dirty || saving) return
    const requestedAccountId = accountId
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.savePharmacyLayout(requestedAccountId, {
        preferredOrder: order,
        expectedRevision: layout.revision,
      })
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      setLayout(response.data)
      setOrder(response.data.preferredOrder)
      setMessage('並び順を保存しました。次回の画像切替時に反映されます。')
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      const readinessMessage = pharmacyRichMenuReadinessMessage(cause)
      if (readinessMessage) {
        setError(readinessMessage)
      } else if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) setError('別の更新がありました。最新の並び順を再取得しました。')
      } else {
        setError('並び順を保存できませんでした。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setSaving(false)
    }
  }

  async function saveLifecycle(state: Lifecycle['state']) {
    if (!lifecycle || lifecycleSaving || lifecycle.state === state) return
    const requestedAccountId = accountId
    setLifecycleSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.savePharmacyLifecycle(requestedAccountId, {
        state,
        expectedRevision: lifecycle.revision,
      })
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      setLifecycle(response.data)
      setMessage('リッチメニュー運用状態を変更しました。LINEの表示は自動変更していません。')
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) setError('別の更新がありました。最新の運用状態を再取得しました。')
      } else {
        setError('リッチメニュー運用状態を変更できませんでした。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setLifecycleSaving(false)
    }
  }

  async function createVersion() {
    if (!layout || layout.revision < 1 || dirty || creating || !versionName.trim()) return
    const requestedAccountId = accountId
    setCreating(true)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.createPharmacyVersion(requestedAccountId, {
        name: versionName.trim(),
        expectedLayoutRevision: layout.revision,
        expectedCapabilityRevision: layout.capabilityRevision,
      })
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      setVersionName('')
      await load()
      if (accountRef.current === requestedAccountId) setMessage('現在の配置を新しい画像versionとして保存しました。LINEにはまだ反映していません。')
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) setError('設定が更新されました。最新状態を確認してもう一度保存してください。')
      } else {
        setError('画像versionを保存できませんでした。catalog設定を確認してください。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setCreating(false)
    }
  }

  async function publishVersion(version: Version) {
    if (publishing) return
    const requestedAccountId = accountId
    setPublishing(version.groupId)
    setError('')
    setMessage('')
    try {
      const preview = await api.richMenuGroups.publishPharmacyVersion(
        version.groupId, requestedAccountId, { dryRun: true },
      )
      if (!preview.success) throw new Error(preview.error)
      const token = preview.data.confirmationToken
      if (!token) throw new Error('Confirmation token was not returned')
      if (!window.confirm(`「${version.name}」をLINE公式アカウントへ登録します。初期表示の切替は登録後に別途行います。`)) return
      const response = await api.richMenuGroups.publishPharmacyVersion(
        version.groupId, requestedAccountId, { dryRun: false, confirmationToken: token },
      )
      if (!response.success) throw new Error(response.error)
      await load()
      if (accountRef.current === requestedAccountId) setMessage('LINEへ登録しました。「この画像に切替」で初期表示を変更できます。')
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) setError('画像または設定が更新されています。最新状態を確認してください。')
      } else {
        setError('LINEへ登録できませんでした。設定漏れとLINE接続を確認してください。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setPublishing(null)
    }
  }

  async function renameVersion(version: Version) {
    if (renaming) return
    const requestedName = window.prompt('新しいversion名を入力してください。', version.name)
    if (requestedName === null || requestedName.trim() === version.name) return
    if (!requestedName.trim() || requestedName.trim().length > 80) {
      setError('version名は1〜80文字で入力してください。')
      return
    }
    const requestedAccountId = accountId
    setRenaming(version.groupId)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.renamePharmacyVersion(
        requestedAccountId,
        version.groupId,
        { name: requestedName.trim(), expectedUpdatedAt: version.updatedAt },
      )
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      setVersions((current) => current.map((item) => item.groupId === version.groupId
        ? { ...item, name: response.data.name, updatedAt: response.data.updatedAt }
        : item))
      setMessage('version名を変更しました。画像とtap actionは変更していません。')
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) setError('別の更新がありました。最新のversion一覧を再取得しました。')
      } else {
        setError('version名を変更できませんでした。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setRenaming(null)
    }
  }

  async function deleteVersion(version: Version) {
    if (deleting || !window.confirm(`下書き「${version.name}」を削除します。元に戻せません。`)) return
    const requestedAccountId = accountId
    setDeleting(version.groupId)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.deletePharmacyVersion(
        requestedAccountId, version.groupId, version.updatedAt,
      )
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      await load()
      if (accountRef.current === requestedAccountId) {
        setMessage(response.data.cleanupPending
          ? '下書きを削除しました。画像ファイルの後片付けは再試行されます。'
          : '下書きを削除しました。')
      }
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        await load()
        if (accountRef.current === requestedAccountId) {
          setError('LINE登録済み・確認済み・結果確認中のversionは削除できません。')
        }
      } else {
        setError('下書きを削除できませんでした。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setDeleting(null)
    }
  }

  async function reconcileVersion(version: Version) {
    if (reconciling || !version.unresolvedOperationId) return
    const requestedAccountId = accountId
    setReconciling(version.groupId)
    setError('')
    setMessage('')
    try {
      const response = await api.richMenuGroups.reconcilePharmacyOperation(
        requestedAccountId, version.unresolvedOperationId,
      )
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      await load()
      if (accountRef.current === requestedAccountId) {
        setMessage(response.data.status === 'succeeded'
          ? 'LINEの現在表示と一致していることを確認しました。'
          : 'LINEの初期表示は変更されていませんでした。')
      }
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      const resumeAvailable = cause instanceof ApiError && cause.status === 409 &&
        cause.data && typeof cause.data === 'object' &&
        typeof (cause.data as { resumableStage?: unknown }).resumableStage === 'string'
      await load()
      if (accountRef.current !== requestedAccountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        setResumable(resumeAvailable ? version.groupId : null)
        setError(version.unresolvedOperationKind === 'publish' && resumeAvailable
          ? '不足しているLINE登録段階を安全に再開できます。内容を確認して「登録を再開」を押してください。'
          : version.unresolvedOperationKind === 'publish'
            ? 'LINE登録状態を自動確定できません。LINE Official Account Managerで手動確認してください。'
          : 'LINEの現在状態が一致しません。手動確認が必要です。')
      } else {
        setError('LINEの状態を確認できませんでした。LINE側は変更していません。もう一度確認してください。')
      }
    } finally {
      if (accountRef.current === requestedAccountId) setReconciling(null)
    }
  }

  async function resumeVersion(version: Version) {
    if (resuming || !version.unresolvedOperationId) return
    const requestedAccountId = accountId
    setResuming(version.groupId)
    setError('')
    setMessage('')
    try {
      const preview = await api.richMenuGroups.resumePharmacyOperation(
        requestedAccountId, version.unresolvedOperationId, { dryRun: true },
      )
      if (!preview.success) throw new Error(preview.error)
      const token = preview.data.confirmationToken
      if (!token) throw new Error('Confirmation token was not returned')
      if (!window.confirm(`「${version.name}」の不足しているLINE登録段階を1つ再開します。実行後にLINEからread-backします。`)) return
      const response = await api.richMenuGroups.resumePharmacyOperation(
        requestedAccountId,
        version.unresolvedOperationId,
        { dryRun: false, confirmationToken: token },
      )
      if (accountRef.current !== requestedAccountId) return
      if (!response.success) throw new Error(response.error)
      setResumable(null)
      await load()
      if (accountRef.current === requestedAccountId) {
        setMessage('LINE登録の不足段階を1つ再開し、read-backを確認しました。続けて「状態を再確認」を押してください。')
      }
    } catch (cause) {
      if (accountRef.current !== requestedAccountId) return
      await load()
      if (accountRef.current !== requestedAccountId) return
      setError(cause instanceof ApiError && cause.status === 409
        ? 'LINEの現在状態が確認時点から変わりました。状態を再確認してください。'
        : 'LINE登録の再開結果を確定できません。再実行せず、状態を再確認してください。')
    } finally {
      if (accountRef.current === requestedAccountId) setResuming(null)
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="pharmacy-rich-menu-layout-title">
      <h2 id="pharmacy-rich-menu-layout-title" className="font-semibold text-gray-900">薬局リッチメニューの並び順</h2>
      <p className="mt-1 text-sm text-gray-600">前へ・後ろへボタンで並び替えます。OFFの機能は画像とリンクの両方から除外されます。</p>
      <ol aria-label="リッチメニュー初期設定の手順" className="mt-3 grid gap-2 text-sm text-gray-700 sm:grid-cols-2">
        <li>1. 患者向け機能をON/OFF</li>
        <li>2. 並び順を保存</li>
        <li>3. 現在の配置を画像として保存</li>
        <li>4. LINEへ登録</li>
        <li>5. この画像に切替</li>
      </ol>
      <p className="mt-2 text-xs text-gray-500">「処方せん事前送信」と「受付状況」は同時にON/OFFされます。</p>
      {staffRole === 'staff' && <p role="status" className="mt-3 rounded bg-blue-50 p-3 text-sm text-blue-900">一般スタッフは閲覧のみです。変更はオーナーまたは管理者が行ってください。</p>}
      {readiness && <div role="status" className="mt-3 rounded bg-gray-50 p-3 text-sm text-gray-800">
        <p>初期設定状態: <span className="font-semibold">{readinessStatusLabel(readiness.status)}</span></p>
        <a
          href={readiness.capabilityEnabled ? '#pharmacy-rich-menu-layout-editor' : '/pharmacy-features'}
          className="mt-1 inline-flex min-h-11 items-center font-medium text-blue-700 underline"
        >
          {readiness.status === 'READY'
            ? '初期設定を確認'
            : readiness.status === 'UNVERIFIED' || versions.length > 0
              ? '初期設定を再開'
              : '初期設定を開始'}
        </a>
      </div>}
      {lifecycle && <fieldset className="mt-3 rounded border border-gray-200 p-3">
        <legend className="px-1 text-sm font-semibold text-gray-900">リッチメニュー運用状態</legend>
        <p className="mb-2 text-sm text-gray-600">状態変更だけではLINEの画像や初期表示を変更しません。</p>
        <div className="flex flex-wrap gap-2">
          {([
            ['inactive', '停止中'],
            ['active', '稼働中'],
            ['frozen', '凍結中'],
          ] as const).map(([state, label]) => <button
            key={state}
            type="button"
            aria-pressed={lifecycle.state === state}
            disabled={lifecycleSaving || lifecycle.state === state || !canMutate}
            onClick={() => void saveLifecycle(state)}
            className="min-h-11 rounded border border-gray-300 px-4 text-sm font-medium aria-pressed:border-green-700 aria-pressed:bg-green-50 aria-pressed:text-green-800 disabled:opacity-60"
          >{label}</button>)}
        </div>
      </fieldset>}
      {error && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {readiness?.capabilityEnabled && readiness.status === 'BLOCKED' && (
        <div className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">設定不足</p>
          <ul className="mt-1 list-disc pl-5">
            {READINESS_LABELS.filter(([key]) => !readiness[key]).map(([key, label]) => <li key={key}>{label}</li>)}
          </ul>
        </div>
      )}
      {readiness?.capabilityEnabled && readiness.status === 'UNVERIFIED' && (
        <p className="mt-3 rounded bg-blue-50 p-3 text-sm text-blue-900">保存設定は揃っています。LINE実画面の初期表示を確認してください。</p>
      )}
      {loading || !layout ? <p className="mt-4 text-sm text-gray-500">設定を読み込み中...</p> : (
        <>
          <ol id="pharmacy-rich-menu-layout-editor" className="mt-4 scroll-mt-4 divide-y divide-gray-200 border-y border-gray-200">
            {order.map((key, index) => {
              const label = PHARMACY_RICH_MENU_LABELS[key] ?? key
              const enabled = layout.effectiveOrder.includes(key)
              return <li key={key} className="flex min-h-14 items-center gap-3 py-2">
                <span className="w-6 text-sm text-gray-500">{index + 1}</span>
                <span className="min-w-0 flex-1 font-medium text-gray-900">{label}</span>
                <span className={`text-xs ${enabled ? 'text-green-700' : 'text-gray-500'}`}>{enabled ? 'ON' : 'OFF'}</span>
                <button type="button" aria-label={`${label}を前へ移動`} disabled={index === 0 || saving || !canMutate} onClick={() => setOrder((current) => movePharmacyRichMenuAction(current, key, -1))} className="min-h-11 min-w-11 rounded border border-gray-300 px-3 disabled:opacity-40">↑</button>
                <button type="button" aria-label={`${label}を後ろへ移動`} disabled={index === order.length - 1 || saving || !canMutate} onClick={() => setOrder((current) => movePharmacyRichMenuAction(current, key, 1))} className="min-h-11 min-w-11 rounded border border-gray-300 px-3 disabled:opacity-40">↓</button>
              </li>
            })}
          </ol>
          <div className="mt-3 rounded bg-gray-50 p-3 text-sm text-gray-700">最後の枠: すべての機能（有効項目数に応じてCompact/Largeを自動選択）</div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-amber-700">{dirty ? '未保存の変更があります。' : '保存済みです。'}</p>
            <button type="button" onClick={() => void save()} disabled={!dirty || saving || !canMutate} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '並び順を保存'}</button>
          </div>
          <div className="mt-6 border-t border-gray-200 pt-5">
            <h3 className="font-semibold text-gray-900">保存済み画像version</h3>
            <p className="mt-1 text-sm text-gray-600">画像とtap actionを一組で保存します。保存だけではLINE表示は変わりません。</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label className="min-w-0 flex-1 text-sm">version名
                <input value={versionName} onChange={(event) => setVersionName(event.target.value)} maxLength={80} disabled={creating || !canMutate} className="mt-1 min-h-11 w-full rounded border border-gray-300 px-3" placeholder="例: 通常営業メニュー" />
              </label>
              <button type="button" onClick={() => void createVersion()} disabled={dirty || creating || !versionName.trim() || !canMutate} className="min-h-11 self-end rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{creating ? '保存中…' : '現在の配置を画像として保存'}</button>
            </div>
            {versions.length === 0 ? <p className="mt-4 text-sm text-gray-500">保存済みversionはありません。</p> : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {versions.map((version) => <article key={version.groupId} className="overflow-hidden rounded-lg border border-gray-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={api.richMenuGroups.imageUrl(version.imageR2Key)} alt={`${version.name}のリッチメニュー画像`} className="w-full bg-gray-100 object-cover" style={{ aspectRatio: version.menuSize === 'large' ? '2500 / 1686' : '2500 / 843' }} />
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2"><h4 className="font-medium text-gray-900">{version.name}</h4><span className="text-xs text-gray-500">{version.status === 'published' ? 'LINE登録済み' : '下書き'}</span></div>
                    <p className="mt-1 text-xs text-gray-500">{version.menuSize === 'large' ? '2500×1686' : '2500×843'} / {version.catalogVersion} / {version.catalogVariantKey}</p>
                    {version.knownGood && <p className="mt-2 text-xs font-medium text-green-700">前回確認済み</p>}
                    {version.unverified && <p className="mt-2 text-xs font-medium text-amber-700">結果確認が必要</p>}
                    <button type="button" onClick={() => void openPreview(version)} disabled={previewLoading !== null} className="mt-3 min-h-11 rounded border border-blue-500 px-3 text-sm font-medium text-blue-800 disabled:opacity-50">{previewLoading === version.groupId ? '確認中…' : '画像とtap領域を確認'}</button>
                    <button type="button" aria-expanded={diff?.groupId === version.groupId} onClick={() => void loadDiff(version)} disabled={diffLoading !== null} className="ml-2 mt-3 min-h-11 rounded border border-violet-500 px-3 text-sm font-medium text-violet-800 disabled:opacity-50">{diffLoading === version.groupId ? '比較中…' : '公開中との差分'}</button>
                    <button type="button" onClick={() => void renameVersion(version)} disabled={renaming !== null || !canMutate} className="ml-2 mt-3 min-h-11 rounded border border-gray-400 px-3 text-sm font-medium text-gray-700 disabled:opacity-50">{renaming === version.groupId ? '変更中…' : '名前を変更'}</button>
                    {diff?.groupId === version.groupId && <div aria-live="polite" className="mt-3 rounded bg-violet-50 p-3 text-sm text-violet-950">
                      {diff.data.status === 'UNVERIFIED'
                        ? <p><span className="font-medium">UNVERIFIED:</span> {DIFF_UNVERIFIED_LABELS[diff.data.reasonCode] ?? '現在表示を確認できません。'}</p>
                        : <><p className="font-medium">{diff.data.imageChanged ? '画像に変更があります。' : '画像は同一です。'}</p><ol className="mt-1 list-decimal pl-5">{diff.data.slots.map((item, index) => <li key={`${item.kind}-${item.currentIndex}-${item.draftIndex}-${index}`}>{pharmacyRichMenuDiffLabel(item)}</li>)}</ol></>}
                    </div>}
                    {version.currentDefault
                      ? <p className="mt-3 text-sm font-medium text-blue-700">現在の初期表示</p>
                      : version.unverified
                        ? <div className="mt-3">
                            <p className="text-sm text-amber-700">再実行せず、LINEの現在表示を確認してください。</p>
                            {version.unresolvedOperationId && <button type="button" onClick={() => void reconcileVersion(version)} disabled={reconciling !== null || !canMutate} className="mt-2 min-h-11 rounded border border-amber-600 px-3 text-sm font-medium text-amber-800 disabled:opacity-50">{reconciling === version.groupId ? '確認中…' : '状態を再確認'}</button>}
                            {resumable === version.groupId && version.unresolvedOperationId && <button type="button" onClick={() => void resumeVersion(version)} disabled={resuming !== null || !canMutate} className="ml-2 mt-2 min-h-11 rounded bg-amber-700 px-3 text-sm font-medium text-white disabled:opacity-50">{resuming === version.groupId ? '再開中…' : '登録を再開'}</button>}
                          </div>
                        : version.status === 'published'
                          ? <button type="button" onClick={() => { setSwitchIntent(version.knownGood ? 'rollback' : 'switch'); setSwitchTarget(version) }} disabled={!canMutate} className="mt-3 min-h-11 rounded border border-green-600 px-3 text-sm font-medium text-green-700 disabled:opacity-50">{version.knownGood ? 'この画像へ戻す' : 'この画像に切替'}</button>
                          : <button type="button" onClick={() => void publishVersion(version)} disabled={publishing !== null || !canMutate} className="mt-3 min-h-11 rounded border border-blue-700 px-3 text-sm font-medium text-blue-700 disabled:opacity-50">{publishing === version.groupId ? '確認中…' : 'LINEへ登録'}</button>}
                    {version.status === 'draft' && !version.lineRichMenuId && !version.currentDefault && !version.knownGood && !version.unverified && <button type="button" onClick={() => void deleteVersion(version)} disabled={deleting !== null || !canMutate} className="ml-2 mt-3 min-h-11 rounded border border-red-500 px-3 text-sm font-medium text-red-700 disabled:opacity-50">{deleting === version.groupId ? '削除中…' : '下書きを削除'}</button>}
                  </div>
                </article>)}
              </div>
            )}
          </div>
        </>
      )}
      {preview && <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4" onKeyDown={(event) => { if (event.key === 'Escape') setPreview(null) }}>
        <div role="dialog" aria-modal="true" aria-labelledby="pharmacy-rich-menu-preview-title" className="mx-auto max-w-4xl rounded-xl bg-white p-4 shadow-xl sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div><h3 id="pharmacy-rich-menu-preview-title" className="text-lg font-semibold">{preview.version.name}</h3><p className="mt-1 text-sm text-gray-600">保存済みJPEGと変更不可のtap領域です。枠を選ぶと位置と動作種別を読み上げます。</p></div>
            <button ref={previewCloseRef} type="button" onClick={() => setPreview(null)} className="min-h-11 rounded border border-gray-400 px-4 text-sm font-medium">閉じる</button>
          </div>
          <div className="relative mt-4 overflow-hidden rounded border border-gray-300 bg-gray-100" style={{ aspectRatio: preview.version.menuSize === 'large' ? '2500 / 1686' : '2500 / 843' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.richMenuGroups.imageUrl(preview.version.imageR2Key)} alt={`${preview.version.name}の保存済みリッチメニュー画像`} className="absolute inset-0 h-full w-full object-cover" />
            {preview.checks.map((check, index) => <span
              key={check.id}
              role="img"
              tabIndex={0}
              aria-label={`tap領域${index + 1}: ${check.actionType}, x ${check.boundsX}, y ${check.boundsY}, 幅 ${check.boundsWidth}, 高さ ${check.boundsHeight}`}
              className="absolute flex items-center justify-center border-2 border-blue-700 bg-blue-200/25 text-xs font-bold text-blue-950 outline-offset-2 focus:outline focus:outline-4 focus:outline-blue-700"
              style={richMenuAreaStyle(check, preview.version.menuSize)}
            >{index + 1}</span>)}
          </div>
          <ol className="mt-4 grid gap-2 text-sm sm:grid-cols-2">{preview.checks.map((check, index) => <li key={check.id} className="rounded bg-gray-50 p-2">{index + 1}. {check.actionType}</li>)}</ol>
        </div>
      </div>}
      {switchTarget && <ApplyToTagModal groupId={switchTarget.groupId} groupName={switchTarget.name} initialMode="set-default" initialDefaultEnabled initialSetDefaultIntent={switchIntent} onClose={() => { setSwitchTarget(null); setSwitchIntent('switch'); void load() }} />}
    </section>
  )
}
