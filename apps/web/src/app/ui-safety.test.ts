import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('cross-screen safety and accessibility', () => {
  it('does not report failed health checks as normal', () => {
    const page = source('./health/page.tsx')
    expect(page).toContain("unknown: { label: '確認不能'")
    expect(page).toContain("risks[account.id] = 'unknown'")
  })

  it('associates friend filters with their labels', () => {
    const page = source('./friends/page.tsx')
    expect(page).toContain('htmlFor="friend-tag-filter"')
    expect(page).toContain('id="friend-tag-filter"')
    expect(page).toContain('htmlFor="friend-response-filter"')
    expect(page).toContain('id="friend-response-filter"')
  })

  it('makes inflow rows keyboard operable', () => {
    const page = source('./inflow-links/page.tsx')
    expect(page).toContain('tabIndex={0}')
    expect(page).toContain('aria-expanded={isExpanded}')
    expect(page).toContain("event.key === 'Enter' || event.key === ' '")
  })

  it('reports partial dashboard failures', () => {
    expect(source('./page.tsx')).toContain('一部のデータを取得できませんでした')
  })

  it('keeps staff actions reachable on narrow screens', () => {
    const page = source('./staff/page.tsx')
    expect(page).toContain('border-gray-200 overflow-x-auto')
    expect(page).toContain('<table className="min-w-full text-sm">')
  })

  it('surfaces link tracking update failures', () => {
    expect(source('../components/broadcasts/broadcast-detail.tsx')).toContain('リンク短縮設定を更新できませんでした')
  })

  it('exposes send confirmation as an escapable dialog', () => {
    const dialog = source('../components/broadcasts/send-confirm-dialog.tsx')
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain("event.key === 'Escape'")
  })

  it('keeps bulk event actions inside the viewport', () => {
    expect(source('../components/events/event-form.tsx')).toContain('max-h-[calc(100vh-2rem)] overflow-y-auto')
  })

  it('keeps platform dashboard sections independent and refreshable', () => {
    const page = source('./platform-admin/page.tsx')
    expect(page).toContain('Promise.allSettled')
    expect(page).toContain('最終更新:')
    expect(page).toContain('再取得')
  })

  it('clears stale logs and treats non-completed retries as failures', () => {
    const page = source('./platform-admin/logs/page.tsx')
    expect(page).toContain('setLogs(null)')
    expect(page).toContain("`${since}T00:00:00+09:00`")
    expect(page).toContain("res.data.outcome !== 'completed'")
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
  })

  it('protects support-mode termination from accidental or duplicate actions', () => {
    const banner = source('../components/platform-admin/support-mode.tsx')
    expect(banner).toContain('window.confirm')
    expect(banner).toContain('const [ending, setEnding]')
    expect(banner).toContain('min-h-11')
    expect(banner).not.toContain('<div role="status" className="bg-amber-500')
  })

  it('confirms tenant suspension impact', () => {
    expect(source('./platform-admin/tenants/detail/page.tsx')).toContain('テナントを停止すると管理画面へのログインと患者向けLINE送信に影響します')
  })

  it('makes audit history searchable and paged with readable tenant labels', () => {
    const page = source('./platform-admin/audit/page.tsx')
    expect(page).toContain('監査履歴を検索')
    expect(page).toContain('PAGE_SIZE')
    expect(page).toContain('tenantNames[event.tenant_id]')
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
  })

  it('keeps tenant operations current and single-flight', () => {
    const detail = source('./platform-admin/tenants/detail/page.tsx')
    expect(detail).toContain("timeZone: 'Asia/Tokyo'")
    expect(detail).toContain('最新情報を再取得')
    expect(detail).toContain('Webhookログを確認')
    expect(detail).toContain('const [working, setWorking]')
  })

  it('shows outbound pause separately from tenant activation', () => {
    const page = source('./platform-admin/tenants/page.tsx')
    expect(page).toContain('患者向けLINE送信一時停止中')
    expect(page).toContain('webhookFailureCount')
    expect(page).toContain('LINE設定不足')
  })

  it('keeps sidebar controls keyboard and touch accessible', () => {
    const sidebar = source('../components/layout/sidebar.tsx')
    expect(sidebar).toContain("event.key === 'Escape'")
    expect(sidebar).toContain('accounts.length === 1')
    expect(sidebar).toContain('min-h-11 items-center gap-2 text-xs text-gray-600')
  })

  it('does not discard account edits from an accidental backdrop tap', () => {
    const modal = source('../components/accounts/account-edit-modal.tsx')
    expect(modal).not.toContain('p-4 overflow-y-auto"\n      onClick={onClose}')
  })

  it('keeps conditional fulfillment requirements consistent and tappable', () => {
    const editor = source('../custom/pharmacy/prescriptions/FulfillmentQuoteEditor.tsx')
    expect(editor).toContain("reasonCodes: decision === 'conditional'")
    expect(editor).toContain('min-h-11 cursor-pointer')
  })

  it('surfaces segment update failures', () => {
    expect(source('../components/broadcasts/broadcast-detail.tsx')).toContain('セグメント条件を更新できませんでした')
  })

  it('uses the mobile dynamic viewport for chat', () => {
    expect(source('./chats/page.tsx')).toContain('100dvh')
  })

  it('keeps narrow tables and rich-menu dialogs reachable', () => {
    expect(source('./booking/staff/shifts/page.tsx')).toContain('max-h-72 overflow-auto')
    const richPage = source('./rich-menus/page.tsx')
    expect(richPage).toContain('border-gray-200 rounded-lg overflow-x-auto')
    expect(richPage).toContain('<table className="min-w-full text-sm">')
    expect(source('../components/rich-menus/apply-to-tag-modal.tsx')).toContain('max-h-[calc(100vh-2rem)] overflow-y-auto')
  })

  it('does not print a trailing blank page', () => {
    expect(source('../custom/pharmacy/prescriptions/PrescriptionPrintPage.tsx')).toContain("index < images.length - 1 ? 'break-after-page' : ''")
  })

  it('bounds long form answers in a fixed-layout table', () => {
    expect(source('./form-submissions/page.tsx')).toContain('w-full min-w-[700px] table-fixed')
  })

  it('keeps friend rows responsive, legible, and tappable', () => {
    const row = source('../components/friends/friend-list-row.tsx')
    expect(row).toContain('grid-cols-1 xl:grid-cols-')
    expect(row).toContain('min-h-11')
    expect(row).not.toContain('text-gray-400')
  })

  it('does not label an account fetch failure as an empty account list', () => {
    expect(source('./accounts/page.tsx')).toContain(') : error ? null : accounts.length === 0 ? (')
  })

  it('keeps platform patient errors generic and dates explicitly JST', () => {
    const list = source('./platform-admin/tenants/patients/page.tsx')
    expect(list).toContain('患者一覧を取得できませんでした。再度お試しください。')
    const detail = source('./platform-admin/tenants/patients/detail/page.tsx')
    expect(detail).toContain("timeZone: 'Asia/Tokyo'")
    expect(detail).toContain('患者情報を取得できませんでした。再度お試しください。')
  })

  it('makes the tenant list searchable, paged, and easy to tap', () => {
    const page = source('./platform-admin/tenants/page.tsx')
    expect(page).toContain('テナントを検索')
    expect(page).toContain('PAGE_SIZE')
    expect(page).toContain('min-h-11')
  })

  it('lets staff filter continuity rows', () => {
    const page = source('../custom/pharmacy/continuity/ContinuityAdminPage.tsx')
    expect(page).toContain('継続フォローを絞り込む')
    expect(page).toContain('visibleItems.map')
  })

  it('distinguishes PHI-free activity rows without exposing patient data', () => {
    expect(source('../custom/pharmacy/activity-notifications/PharmacyActivityNotificationsPage.tsx')).toContain('通知ID:')
  })

  it('only reloads platform logs when submitted and labels bounded results', () => {
    const page = source('./platform-admin/logs/page.tsx')
    expect(page).toContain('取得件数')
    expect(page).toContain('useEffect(() => { void load() }, [])')
    expect(page).toContain('LOG_COLUMN_LABELS')
  })

  it('waits for wide screens before splitting patient intake columns', () => {
    expect(source('../custom/pharmacy/intake/PatientIntakeAdminPage.tsx')).toContain('xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')
  })

  it('does not expose raw rich-menu API errors', () => {
    expect(source('./rich-menus/page.tsx')).toContain('リッチメニューを取得できませんでした。再度お試しください。')
  })

  it('clears stale platform-admin success notices before another operation', () => {
    const detail = source('./platform-admin/tenants/detail/page.tsx')
    expect(detail.match(/setNotice\(''\)/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('requires a meaningful support-mode audit reason', () => {
    const support = source('../components/platform-admin/support-mode.tsx')
    expect(support).toContain('minLength={10}')
    expect(support).toContain('10文字以上')
  })
})
