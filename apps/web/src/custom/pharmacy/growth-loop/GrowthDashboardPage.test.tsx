import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MedicalSourceManager, monthRangeJst } from './GrowthDashboardPage'

describe('growth dashboard source manager', () => {
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
      '計測可能な友だち追加', '未成熟', '発行元分類率', 'other / (primary + other)',
      '遅延件数', '準備完了・予定なし', '確認済み使用期限', '期限前日通知後に期限内完了',
      '通知上限で停止', '能動通知の試行', 'サンプル数', '推定される時間的関連',
      '集計月',
    ]) expect(source).toContain(label)
  })
})
