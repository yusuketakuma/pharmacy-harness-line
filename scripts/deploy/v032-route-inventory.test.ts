import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildV032RouteInventory,
  discoverCustomPharmacyRouteSources,
  inventorySourceExists,
  type InventoryEntry,
} from './v032-route-inventory.js';

const repoRoot = process.cwd();

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function allEntries(inventory: ReturnType<typeof buildV032RouteInventory>): InventoryEntry[] {
  return [...inventory.pages, ...inventory.apis];
}

describe('V032 route inventory', () => {
  it('has a machine-readable pharmacy and platform-admin inventory', () => {
    const inventory = buildV032RouteInventory();
    expect(inventory.pages.length).toBeGreaterThan(0);
    expect(inventory.apis.length).toBeGreaterThan(0);
    expect(inventory.snapshot).toBe('eaf35aa8aa8bb6cd831c84d30d2067662b48d3b7');
    expect(new Set(allEntries(inventory).map((entry) => entry.surface))).toContain('patient-liff');
  });

  it('covers every patient pharmacy LIFF page and API boundary', () => {
    const inventory = buildV032RouteInventory();
    const patientPages = inventory.pages
      .filter((entry) => String(entry.surface) === 'patient-liff')
      .map((entry) => entry.path)
      .sort();
    expect(patientPages).toEqual([
      '/pharmacy/continuity',
      '/pharmacy/emergency-contraception',
      '/pharmacy/info',
      '/pharmacy/medication-followup',
      '/pharmacy/menu',
      '/pharmacy/patient-intake',
      '/pharmacy/receive',
      '/prescriptions',
    ]);

    const routeKeys = inventory.apis.flatMap((entry) =>
      (entry.routePaths ?? []).map((route) => `${route.method} ${route.path}`));
    for (const key of [
      'GET /api/liff/config',
      'GET /api/liff/pharmacy/feature-access',
      'GET /api/liff/pharmacy/prescriptions/me',
      'PUT /api/liff/pharmacy/prescriptions/:id/files/:position',
      'POST /api/liff/pharmacy/patients/:id/intake',
      'POST /api/liff/pharmacy/continuity/expectations/:id/respond',
      'POST /api/liff/pharmacy/myna-handoffs/:id/patient-report',
      'POST /api/liff/pharmacy/medication-followups/:id/respond',
      'POST /api/liff/pharmacy/emergency-contraception/intakes',
      'GET /api/liff/pharmacy/public-profile',
      'GET /api/liff/pharmacy/privacy-policy',
    ]) expect(routeKeys).toContain(key);
  });

  it('covers every current custom pharmacy route source exactly once', () => {
    const inventory = buildV032RouteInventory();
    const expectedSources = discoverCustomPharmacyRouteSources(repoRoot);
    const actualSources = inventory.apis
      .filter((entry) => entry.surface !== 'patient-liff')
      .filter((entry) => entry.source.startsWith('apps/worker/src/custom/pharmacy/'))
      .map((entry) => entry.source)
      .sort();

    expect(actualSources).toEqual(expectedSources);
    expect(new Set(actualSources).size).toBe(actualSources.length);
    for (const entry of inventory.apis) {
      expect(entry.routePaths?.length, `${entry.id} has no route declaration`).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate method/path declarations and records every expanded route', () => {
    const inventory = buildV032RouteInventory();
    const routeKeys = inventory.apis.flatMap((entry) =>
      (entry.routePaths ?? []).map((route) => `${route.method} ${route.path}`));
    expect(new Set(routeKeys).size, 'duplicate METHOD path in inventory').toBe(routeKeys.length);
    expect(routeKeys.length).toBeGreaterThan(150);
    expect(routeKeys).toContain('POST /api/friends/:id/messages');
    expect(routeKeys).toContain('POST /api/meet-consultations');
    expect(routeKeys).toContain('POST /api/custom/pharmacy/prescriptions/:id/actions/:action');
  });

  it('references only existing page, component, route, and regression-test files', () => {
    const inventory = buildV032RouteInventory();
    for (const entry of allEntries(inventory)) {
      expect(entry.testReferences.length, `${entry.id} has no test reference`).toBeGreaterThan(0);
      expect(inventorySourceExists(repoRoot, entry), `${entry.id} has a missing source/test reference`).toBe(true);
    }

    const platformPageSources = walkFiles(join(repoRoot, 'apps/web/src/app/platform-admin'))
      .filter((path) => basename(path) === 'page.tsx')
      .map((path) => relative(repoRoot, path).split('/').join('/'))
      .sort();
    const inventoryPlatformSources = inventory.pages
      .filter((entry) => entry.surface === 'platform-admin')
      .map((entry) => entry.source)
      .sort();
    expect(inventoryPlatformSources).toEqual(platformPageSources);
  });

  it('covers the pharmacy menu paths and pharmacy-only sidebar paths', () => {
    const inventory = buildV032RouteInventory();
    const menuPaths = new Set(
      [...read('apps/web/src/custom/pharmacy/growth-loop/menu.ts').matchAll(/['"](\/[^'"]*)['"]/gu)]
        .map((match) => match[1]),
    );
    const sidebarPaths = [...read('apps/web/src/components/layout/sidebar.tsx').matchAll(
      /\{\s*href:\s*'([^']+)'[^}]*pharmacyOnly:\s*true/gu,
    )].map((match) => match[1]);
    for (const path of [...menuPaths, ...sidebarPaths]) {
      expect(
        inventory.pages.some((entry) => entry.surface === 'pharmacy-admin' && entry.path === path),
        `menu/sidebar path ${path} is absent from inventory`,
      ).toBe(true);
    }

    const pharmacyPageSources = inventory.pages
      .filter((entry) => entry.surface === 'pharmacy-admin')
      .map((entry) => entry.source);
    for (const path of [...menuPaths, ...sidebarPaths]) {
      expect(pharmacyPageSources).toContain(
        `apps/web/src/app${path === '/' ? '/page.tsx' : `${path}/page.tsx`}`,
      );
    }
  });

  it('requires role, scope, mutation, confirmation, PHI, audit, and boundary fields', () => {
    const inventory = buildV032RouteInventory();
    for (const entry of allEntries(inventory)) {
      expect(entry.roles, `${entry.id} roles`).not.toHaveLength(0);
      expect(entry.authority, `${entry.id} authority`).toMatch(/\S/u);
      expect(entry.lineAccountIdAuthority, `${entry.id} line_account_id authority`).toMatch(/\S/u);
      expect(entry.displayedInfo, `${entry.id} displayedInfo`).not.toHaveLength(0);
      expect(entry.mutation, `${entry.id} mutation`).toMatch(/\S/u);
      expect(entry.confirmation, `${entry.id} confirmation`).toMatch(/\S/u);
      expect(entry.phiClassification, `${entry.id} PHI classification`).toMatch(/\S/u);
      expect(entry.audit, `${entry.id} audit`).toMatch(/\S/u);
      expect(entry.queryAuthority, `${entry.id} query authority`).toMatch(/\S/u);
      expect(entry.manualOneToOne, `${entry.id} manual one-to-one`).toMatch(/^(required|not-applicable)$/u);
      expect(entry.meetFollowUp, `${entry.id} Meet follow-up`).toMatch(
        /^(not-applicable|required-calendar-and-reminders|unverified-existing-gap)$/u,
      );
      expect(entry.reachability, `${entry.id} reachability`).toMatch(/^(reachable|source-only-unmounted|deferred)$/u);
      expect(entry.lineAccountIdAuthority).not.toMatch(/query parameter is authority|query is authority/iu);
    }
  });

  it('keeps query parameters as selectors and preserves the manual one-to-one boundary', () => {
    const inventory = buildV032RouteInventory();
    const friends = inventory.apis.find((entry) => entry.id === 'api-friends');
    const chats = inventory.apis.find((entry) => entry.id === 'api-chats');
    const friendsPage = inventory.pages.find((entry) => entry.id === 'page-generic-friends');
    const chatsPage = inventory.pages.find((entry) => entry.id === 'page-generic-chats');
    expect(friends?.manualOneToOne).toBe('required');
    expect(chats?.manualOneToOne).toBe('required');
    expect(friendsPage?.manualOneToOne).toBe('required');
    expect(chatsPage?.manualOneToOne).toBe('required');
    expect(friends?.confirmation).toContain('X-Line-Harness-Source: manual');
    expect(chats?.confirmation).toContain('X-Line-Harness-Source: manual');
    expect(chatsPage?.confirmation).toContain('X-Line-Harness-Source: manual');
    expect(read('apps/web/src/app/chats/page.tsx')).toContain('X-Line-Harness-Source');
    expect(read('apps/worker/src/routes/crm/friends-manual-message.test.ts')).toContain('X-Line-Harness-Source');

    for (const entry of inventory.apis.filter((item) => item.queryAuthority === 'selector-only-server-validated')) {
      expect(entry.authority).toMatch(/server/u);
      expect(entry.lineAccountIdAuthority).toMatch(/server/iu);
    }
  });

  it('classifies Meet consultation follow-up and keeps the recovery source mounted behind platform auth', () => {
    const inventory = buildV032RouteInventory();
    const meet = inventory.apis.find((entry) => entry.id === 'api-meet-consultations');
    const recovery = inventory.apis.find((entry) => entry.id === 'api-platform-data-protection');
    expect(meet).toMatchObject({
      meetFollowUp: 'required-calendar-and-reminders',
      queryAuthority: 'server-tenant/account-bound',
    });
    expect(meet?.confirmation).toMatch(/calendar|reminders/iu);
    expect(recovery).toMatchObject({ reachability: 'reachable' });
    expect(recovery?.routePaths).toContainEqual({
      method: 'POST',
      path: '/api/platform-admin/data-protection/recovery-operations',
    });
    const workerIndex = read('apps/worker/src/index.ts');
    expect(workerIndex).toContain("import { platformAdminDataProtectionRoutes } from './custom/pharmacy/platform-admin/data-protection-routes.js'");
    expect(workerIndex.indexOf("app.use('/api/platform-admin/*', platformAdminAuthMiddleware)"))
      .toBeLessThan(workerIndex.indexOf("app.route('/', platformAdminDataProtectionRoutes)"));
  });

  it('does not treat patient PHI as a default platform-admin display', () => {
    const inventory = buildV032RouteInventory();
    const patientEntries = inventory.pages.filter((entry) => entry.path.includes('/patients'));
    expect(patientEntries).toHaveLength(2);
    expect(patientEntries.every((entry) => entry.phiClassification === 'PHI-with-support-grant')).toBe(true);
    expect(inventory.pages.filter((entry) => entry.surface === 'platform-admin')
      .filter((entry) => !entry.path.includes('/patients'))
      .every((entry) => entry.phiClassification === 'PHI-free-default' || entry.phiClassification === 'credentials'))
      .toBe(true);
  });
});
