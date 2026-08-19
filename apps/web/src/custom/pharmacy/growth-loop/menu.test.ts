import { describe, expect, it } from 'vitest'
import { isPharmacyMenuPath } from './menu'

describe('pharmacy admin menu allowlist', () => {
  it('keeps care operations and hides generic growth features', () => {
    for (const path of [
      '/', '/friends', '/chats', '/prescriptions', '/patient-intakes', '/continuity',
      '/myna', '/pharmacy-growth', '/rich-menus', '/pharmacy-notifications', '/staff', '/accounts',
    ]) {
      expect(isPharmacyMenuPath(path)).toBe(true)
    }
    for (const path of [
      '/broadcasts', '/scenarios', '/automations', '/auto-replies', '/reminders',
      '/affiliates', '/scoring', '/pools', '/webinars', '/friend-add-settings',
      '/notifications', '/updates',
    ]) {
      expect(isPharmacyMenuPath(path)).toBe(false)
    }
  })
})
