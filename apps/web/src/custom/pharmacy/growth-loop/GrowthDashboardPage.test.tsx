import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasMessagingRecords,
  isCurrentDashboardRequest,
  isCurrentSourceAccount,
  isCurrentSourceRequest,
  MedicalSourceManager,
  monthRangeJst,
  nextSourceAccount,
  nextSourceRequest,
  notificationOutcomeCount,
} from './GrowthDashboardPage'

describe('growth dashboard source manager', () => {
  it('totals notification outcomes across PHI-free categories', () => {
    expect(notificationOutcomeCount({
      'transactional_care:sent': 2,
      'followup_care:sent': 1,
      'continuity:failed': 3,
      'proactive_noncare:blocked': 4,
    }, 'sent')).toBe(3)
  })

  it('distinguishes an empty messaging period from recorded activity', () => {
    expect(hasMessagingRecords({
      sent: 0, received: 0, attempted: 0, reconciliationRequired: 0,
    })).toBe(false)
    expect(hasMessagingRecords({
      sent: 0, received: 1, attempted: 0, reconciliationRequired: 0,
    })).toBe(true)
  })

  it('uses JST calendar-month boundaries for monthly metrics', () => {
    expect(monthRangeJst('2026-08')).toEqual({
      from: '2026-07-31T15:00:00.000Z',
      to: '2026-08-31T15:00:00.000Z',
    })
    expect(monthRangeJst('2026-12')).toEqual({
      from: '2026-11-30T15:00:00.000Z',
      to: '2026-12-31T15:00:00.000Z',
    })
  })

  it('rejects a response after the account changes or a newer reload starts', () => {
    const request = { id: 1, key: 'account-a\u00002026-08' }

    expect(isCurrentDashboardRequest(request, { id: 2, key: 'account-b\u00002026-08' })).toBe(false)
    expect(isCurrentDashboardRequest(request, { id: 2, key: request.key })).toBe(false)
    expect(isCurrentDashboardRequest(request, request)).toBe(true)
  })

  it('keeps a source mutation across month changes but rejects an account ABA', async () => {
    let current = { generation: 0, accountId: 'account-a' }
    const operationAccount = current
    let rejectOperation!: (reason?: unknown) => void
    const pendingOperation = new Promise<void>((_, reject) => { rejectOperation = reject })
    const updates: string[] = []
    const completion = pendingOperation.catch(() => {
      if (isCurrentSourceAccount(operationAccount, current)) updates.push('error')
    }).finally(() => {
      if (isCurrentSourceAccount(operationAccount, current)) updates.push('idle')
    })

    expect(nextSourceAccount(current, 'account-a')).toBe(current)
    current = nextSourceAccount(current, 'account-b')
    current = nextSourceAccount(current, 'account-a')
    rejectOperation(new Error('old selection failed'))
    await completion

    expect(updates).toEqual([])
    expect(isCurrentSourceAccount({ generation: 2, accountId: 'account-a' }, current)).toBe(true)
  })

  it('rejects an older dashboard source read after a mutation refresh starts', () => {
    const account = { generation: 0, accountId: 'account-a' }
    let current = { id: 0, ...account }
    const dashboardRead = nextSourceRequest(current, account)
    current = dashboardRead
    const mutationRefresh = nextSourceRequest(current, account)
    current = mutationRefresh

    expect(isCurrentSourceRequest(dashboardRead, current)).toBe(false)
    expect(isCurrentSourceRequest(mutationRefresh, current)).toBe(true)
  })

  it('shows account-scoped source creation and active-state controls', () => {
    const html = renderToStaticMarkup(<MedicalSourceManager
      sources={[
        { id: 'source-1', display_name: 'Clinic A', classification: 'primary', is_active: 1 },
        { id: 'source-2', display_name: 'Clinic B', classification: 'other', is_active: 0 },
      ]}
      busy={false}
      onCreate={async () => undefined}
      onSetActive={async () => undefined}
    />)

    expect(html).toContain('発行元マスター')
    expect(html).toContain('Clinic A')
    expect(html).toContain('無効にする')
    expect(html).toContain('有効に戻す')
  })

  it('keeps every Release 1 metric and its denominator caveat visible', () => {
    const source = readFileSync(join(process.cwd(), 'src/custom/pharmacy/growth-loop/GrowthDashboardPage.tsx'), 'utf8')
    for (const label of [
      '計測可能な友だち追加', '未成熟', '発行元分類率', 'その他 ÷ 分類済み',
      '遅延件数', '準備完了・予定なし', '確認済み使用期限', '期限前日通知後に期限内完了',
      '月間上限で見送り', '能動通知の試行', 'サンプル数', '推定される時間的関連',
      '通知送信済み', '通知処理中', '通知失敗', '通知見送り', '要確認（24時間超）',
      '送信記録数（テスト除外）', '受信記録数', '手動送信', '自動送信',
      'push送信', 'reply送信', '一意の対応者数', '旧記録（アカウント未確定）',
      '送信元未確認', '配信種別未確認', 'この期間のメッセージ記録はありません。',
      'LINE送信処理中', 'LINE送信要確認',
      '集計月',
    ]) expect(source).toContain(label)
    expect(source).toContain('送信経路ごとの再送期限を超えた結果不明の送信です')
    expect(source).not.toContain('note="24時間を超えた結果不明の送信です"')
  })

  it('keeps source failures separate and never shows a previous month as the selected month', () => {
    const source = readFileSync(join(process.cwd(), 'src/custom/pharmacy/growth-loop/GrowthDashboardPage.tsx'), 'utf8')

    expect(source).toContain('Promise.allSettled')
    expect(source).toContain('setSourceError')
    expect(source).toContain('setSourceActionError')
    expect(source).not.toContain("setSourceBusy(true); setError('')")
    expect(source).toContain('変更は保存されましたが、発行元マスターを再取得できませんでした。')
    expect(source).toContain('dataMonth === month')
    expect(source).toContain('dataAccountId === selectedAccountId')
    expect(source).toContain("timeZone: 'Asia/Tokyo'")
    expect(source).toContain('その他 ÷ 分類済み')
  })

  it('announces account and dashboard loading states', () => {
    const source = readFileSync(join(process.cwd(), 'src/custom/pharmacy/growth-loop/GrowthDashboardPage.tsx'), 'utf8')

    expect(source.match(/role="status"/g) ?? []).toHaveLength(2)
  })
})
