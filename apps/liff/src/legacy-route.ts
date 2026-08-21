import { PHARMACY_LEGACY_PAGE_TARGETS } from './custom/pharmacy/rich-menu/legacy-routes.js';

/**
 * Translate links emitted by the Worker-served LIFF client into the path
 * routes used by the Pages LIFF client. Keeping this compatibility layer
 * means links already delivered to users continue to work after an install
 * changes topology during an update.
 */
export function legacyQueryTarget(search: string): string {
  let params = new URLSearchParams(search);
  const page = params.get('page');
  params.delete('page');

  // Pharmacy build: the menu is the safe default, not the salon booking page.
  let pathname = '/pharmacy/menu';
  const pharmacyPath = page ? PHARMACY_LEGACY_PAGE_TARGETS[page] : undefined;
  if (pharmacyPath) {
    const [targetPath, targetQuery = ''] = pharmacyPath.split('?', 2);
    pathname = targetPath;
    const merged = new URLSearchParams(targetQuery);
    params.forEach((value, key) => {
      if (!merged.has(key)) merged.append(key, value);
    });
    params = merged;
  } else {
    switch (page) {
      case 'webinar': {
        const slug = params.get('slug');
        if (!slug) break;
        params.delete('slug');
        pathname = `/webinar/${encodeURIComponent(slug)}`;
        break;
      }
      case 'event': {
        const id = params.get('id');
        if (!id) break;
        params.delete('id');
        pathname = `/events/${encodeURIComponent(id)}`;
        break;
      }
      case 'event-me':
        pathname = '/events/me';
        break;
      case 'affiliate':
        pathname = '/affiliate';
        break;
      case 'prescription':
        pathname = '/prescriptions';
        break;
      case 'book':
      case 'salon-book':
        pathname = '/booking';
        break;
      case null:
      default:
        // The Pages app does not implement every Worker-client page (notably
        // forms). Fall back to the pharmacy menu instead of a broken path.
        pathname = '/pharmacy/menu';
    }
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
