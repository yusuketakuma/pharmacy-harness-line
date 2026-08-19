const PHARMACY_MENU_PATHS = new Set([
  '/',
  '/friends',
  '/chats',
  '/prescriptions',
  '/patient-intakes',
  '/continuity',
  '/myna',
  '/pharmacy-growth',
  '/rich-menus',
  '/pharmacy-notifications',
  '/staff',
  '/accounts',
])

export function isPharmacyMenuPath(path: string): boolean {
  return PHARMACY_MENU_PATHS.has(path)
}
