import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isPharmacyMenuPath } from './menu'

describe('pharmacy general-menu allowlist', () => {
  it('keeps the general entries a pharmacy tenant can actually use', () => {
    for (const path of ['/', '/friends', '/chats', '/rich-menus', '/staff', '/accounts']) {
      expect(isPharmacyMenuPath(path)).toBe(true)
    }
  })

  // Regression: 未対応 was missing from this list, so pharmacy staff had no way to
  // reach the conversation inbox even though the sidebar was polling its badge.
  it('includes 未対応, whose APIs are server-allowed for pharmacy tenants', () => {
    expect(isPharmacyMenuPath('/notifications')).toBe(true)

    const page = readFileSync(
      join(process.cwd(), 'src', 'app', 'notifications', 'page.tsx'),
      'utf8',
    )
    const namespaces = [...page.matchAll(/api\.([a-zA-Z]+)/g)].map(([, name]) => name)
    expect(new Set(namespaces)).toEqual(new Set(['inbox', 'lineAccounts']))
  })

  it('excludes entries the server 403s for a pharmacy tenant', () => {
    // Each of these renders a screen whose API is outside the worker's
    // PHARMACY_ALLOWED_API_PREFIXES, so a pharmacy tenant only reaches an error.
    for (const path of [
      '/tags', '/templates', '/scenarios', '/broadcasts', '/reminders', '/webinars',
      '/automations', '/auto-replies', '/webhooks', '/affiliates', '/conversions',
      '/scoring', '/form-submissions', '/duplicates', '/users', '/health',
      '/inflow-links', '/friend-add-settings', '/pools', '/events',
      '/booking/bookings', '/booking/menus', '/booking/staff',
    ]) {
      expect(isPharmacyMenuPath(path)).toBe(false)
    }
  })

  // 緊急コントロール drives broadcasts/scenarios, both disabled for pharmacy tenants.
  // Showing a red danger button that cannot stop anything is worse than hiding it.
  it('excludes 緊急コントロール, which cannot halt anything for a pharmacy tenant', () => {
    expect(isPharmacyMenuPath('/emergency')).toBe(false)
  })
})
