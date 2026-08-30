import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TriggerTagField } from './scenario-mode-picker'

const noop = () => undefined

describe('scenario trigger tag field', () => {
  it('disables the select and guides to tag management when no tags exist', () => {
    const html = renderToStaticMarkup(
      <TriggerTagField tagsState="ready" tags={[]} value="" onChange={noop} />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('タグがまだ1つもありません')
    expect(html).toContain('href="/tags"')
  })

  it('explains a failed tag fetch instead of leaving a blank select', () => {
    const html = renderToStaticMarkup(
      <TriggerTagField tagsState="failed" tags={[]} value="" onChange={noop} />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('タグ一覧を取得できませんでした')
  })

  it('disables the select while tags are loading', () => {
    const html = renderToStaticMarkup(
      <TriggerTagField tagsState="loading" tags={[]} value="" onChange={noop} />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('読み込み中')
  })

  it('enables the select and lists tags when loaded', () => {
    const html = renderToStaticMarkup(
      <TriggerTagField
        tagsState="ready"
        tags={[{ id: 'tag-1', name: '来店済み' } as never]}
        value=""
        onChange={noop}
      />,
    )
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('来店済み')
  })
})
