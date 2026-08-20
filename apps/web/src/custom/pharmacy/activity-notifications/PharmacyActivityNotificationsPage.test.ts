import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { activityAcknowledgementMessage } from './PharmacyActivityNotificationsPage'

describe('pharmacy activity notifications', () => {
  it('explains that acknowledging removes the item from the queue', () => {
    const message = activityAcknowledgementMessage()

    expect(message).toContain('一覧から消えます')
    expect(message).toContain('戻せません')
  })

  it('keeps acknowledgement failures visible and prevents polling from restoring removed rows', () => {
    const page = readFileSync(new URL('./PharmacyActivityNotificationsPage.tsx', import.meta.url), 'utf8')

    expect(page).toContain('acknowledgedIds.current.has')
    expect(page).toContain('setLoadError')
    expect(page).toContain('setActionError')
    expect(page).toContain('loadError && items.length === 0')
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
  })
})
