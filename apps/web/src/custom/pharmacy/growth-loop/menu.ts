// Which general-CRM menu entries a pharmacy tenant can actually reach.
//
// This mirrors the server's allowlist in
// apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.ts, which is
// fail-closed: any /api path outside PHARMACY_ALLOWED_API_PREFIXES returns 403 for a
// pharmacy tenant. Without this filter the sidebar advertises ~22 entries that load a
// screen and immediately fail — including 緊急コントロール, a red danger button that
// cannot actually stop anything for a pharmacy.
//
// A path belongs here only if every API the page calls is server-allowed:
//   /                    → pharmacy tenants render GrowthDashboardPage instead
//   /friends             → /api/friends
//   /chats               → /api/chats, /api/friends
//   /notifications       → /api/inbox, /api/line-accounts
//   /rich-menus          → /api/rich-menu-groups
//   /staff               → /api/staff
//   /accounts            → /api/line-accounts, /api/rich-menu-groups
// The 薬局機能 section is shown by its own `pharmacyOnly` flag, not by this list.
const PHARMACY_MENU_PATHS = new Set([
  '/',
  '/friends',
  '/chats',
  '/notifications',
  '/rich-menus',
  '/staff',
  '/accounts',
])

export function isPharmacyMenuPath(path: string): boolean {
  return PHARMACY_MENU_PATHS.has(path)
}
