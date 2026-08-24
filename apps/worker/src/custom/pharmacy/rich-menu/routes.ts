import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createRichMenuGroup,
  deleteRichMenuGroup,
  getLineAccountByIdForTenant,
  getRichMenuGroupWithPages,
  type RichMenuAreaInput,
  type RichMenuGroupWithPages,
} from '@line-crm/db';
import type { Env } from '../../../index.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';
import {
  buildPharmacyCatalogRichMenu,
  diffPharmacyRichMenuManifests,
  getPharmacyRichMenuCatalogPreview,
  hashPharmacyRichMenuManifest,
} from './profile.js';
import { savePharmacyRichMenuImage } from './storage.js';
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { getPharmacyCapabilityConfig } from '../growth-loop/repository.js';
import {
  derivePharmacyRichMenuLayout,
  validatePharmacyRichMenuPreferredOrder,
} from './layout.js';
import {
  createPharmacyRichMenuDraftBinding,
  deletePharmacyRichMenuVersion,
  getPharmacyRichMenuLayout,
  getPharmacyRichMenuCurrentDefaultEvidence,
  getPharmacyRichMenuLifecycleControl,
  listPharmacyRichMenuVersions,
  renamePharmacyRichMenuVersion,
  savePharmacyRichMenuLayout,
  savePharmacyRichMenuLifecycleControl,
  type PharmacyRichMenuLayout,
} from './repository.js';
import {
  PHARMACY_RICH_MENU_CATALOG_VERSION,
  loadPharmacyRichMenuCatalogImage,
} from './catalog.js';
import { sha256Hex } from './hash.js';

export const pharmacyRichMenuRoutes = new Hono<Env>();

const EVIDENCE_FRESHNESS_HOURS = 24;

function serializeLayout(
  layout: PharmacyRichMenuLayout,
  capabilities: Awaited<ReturnType<typeof getPharmacyCapabilityConfig>>,
) {
  if (!capabilities) throw new Error('pharmacy capability config not found');
  return {
    preferredOrder: layout.preferredOrder,
    ...derivePharmacyRichMenuLayout(layout.preferredOrder, capabilities.capabilities),
    revision: layout.revision,
    capabilityRevision: capabilities.revision,
    updatedAt: layout.updatedAt,
  };
}

async function canAccessPharmacyRichMenu(c: Context<Env>, accountId: string): Promise<boolean> {
  const staff = c.get('staff');
  return Boolean(staff) &&
    await canAccessPharmacyOperationsAccount(c.env.DB, staff, accountId, c.env.LINE_CHANNEL_ID) &&
    await hasPharmacyCapability(c.env.DB, accountId, 'pharmacy_rich_menu');
}

function canMutatePharmacyRichMenu(c: Context<Env>): boolean {
  const role = c.get('staff')?.role;
  return role === 'owner' || role === 'admin';
}

function groupManifestAreas(group: RichMenuGroupWithPages): RichMenuAreaInput[] | null {
  const page = group.pages.find((candidate) => candidate.id === group.default_page_id) ?? group.pages[0];
  return page?.areas.map((area) => ({
    boundsX: area.bounds_x,
    boundsY: area.bounds_y,
    boundsWidth: area.bounds_width,
    boundsHeight: area.bounds_height,
    actionType: area.action_type,
    actionData: area.actionData,
  })) ?? null;
}

async function loadPharmacyRichMenuCandidate(
  c: Context<Env>,
  accountId: string,
  expected?: { layoutRevision: number; capabilityRevision: number },
) {
  const [layout, capabilities] = await Promise.all([
    getPharmacyRichMenuLayout(c.env.DB, accountId),
    getPharmacyCapabilityConfig(c.env.DB, accountId),
  ]);
  if (!capabilities) throw new Error('pharmacy capability config not found');
  if (expected && (layout.revision !== expected.layoutRevision ||
      capabilities.revision !== expected.capabilityRevision)) {
    throw new Error('stale pharmacy rich-menu candidate revision');
  }
  const { effectiveOrder, variantKey } = derivePharmacyRichMenuLayout(
    layout.preferredOrder, capabilities.capabilities,
  );
  const catalog = await loadPharmacyRichMenuCatalogImage(c.env.IMAGES, effectiveOrder);
  if (catalog.variantKey !== variantKey) throw new Error('pharmacy rich-menu catalog variant changed');
  return { layout, capabilities, effectiveOrder, catalog };
}

async function compareCandidateWithCurrent(
  c: Context<Env>,
  accountId: string,
  candidateAreas: readonly RichMenuAreaInput[],
  candidateImageHash: string,
) {
  const freshAfter = new Date(
    Date.now() - EVIDENCE_FRESHNESS_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const evidence = await getPharmacyRichMenuCurrentDefaultEvidence(c.env.DB, accountId, freshAfter);
  if (!evidence) {
    return { syncStatus: 'UNVERIFIED' as const, reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE' as const };
  }
  const current = (await listPharmacyRichMenuVersions(c.env.DB, accountId))
    .find((version) => version.groupId === evidence.groupId);
  if (!current) {
    return { syncStatus: 'UNVERIFIED' as const, reasonCode: 'CURRENT_DEFAULT_VERSION_MISSING' as const };
  }
  const currentGroup = await getRichMenuGroupWithPages(c.env.DB, evidence.groupId);
  const currentAreas = currentGroup?.account_id === accountId ? groupManifestAreas(currentGroup) : null;
  if (!currentAreas) {
    return { syncStatus: 'UNVERIFIED' as const, reasonCode: 'CURRENT_DEFAULT_MANIFEST_UNAVAILABLE' as const };
  }
  const diff = diffPharmacyRichMenuManifests(
    currentAreas, candidateAreas, current.imageHash, candidateImageHash,
  );
  const syncStatus = !diff.imageChanged && diff.slots.every((slot) => slot.kind === 'same')
    ? 'CURRENT' as const : 'STALE' as const;
  return {
    syncStatus,
    verifiedAt: evidence.verifiedAt,
    imageChanged: diff.imageChanged,
    changes: diff.slots,
  };
}

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/layout', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const [layout, capabilities] = await Promise.all([
    getPharmacyRichMenuLayout(c.env.DB, accountId),
    getPharmacyCapabilityConfig(c.env.DB, accountId),
  ]);
  if (!capabilities) return c.json({ success: false, error: 'pharmacy config not found' }, 404);
  return c.json({ success: true, data: serializeLayout(layout, capabilities) });
});

pharmacyRichMenuRoutes.put('/api/custom/pharmacy/rich-menus/layout', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!canMutatePharmacyRichMenu(c) || !await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  let body: { preferredOrder?: unknown; expectedRevision?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'valid JSON body required' }, 400);
  }
  if (!Array.isArray(body.preferredOrder) ||
      body.preferredOrder.some((value) => typeof value !== 'string') ||
      !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return c.json({ success: false, error: 'preferredOrder and expectedRevision are required' }, 400);
  }
  let preferredOrder: ReturnType<typeof validatePharmacyRichMenuPreferredOrder>;
  try {
    preferredOrder = validatePharmacyRichMenuPreferredOrder(body.preferredOrder);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 400);
  }

  try {
    const layout = await savePharmacyRichMenuLayout(
      c.env.DB, accountId, preferredOrder, Number(body.expectedRevision),
    );
    const capabilities = await getPharmacyCapabilityConfig(c.env.DB, accountId);
    if (!capabilities) return c.json({ success: false, error: 'pharmacy config not found' }, 404);
    return c.json({ success: true, data: serializeLayout(layout, capabilities) });
  } catch (error) {
    if (String(error).includes('stale pharmacy rich-menu layout revision')) {
      return c.json({ success: false, error: 'stale pharmacy rich-menu layout revision' }, 409);
    }
    throw error;
  }
});

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/candidate', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const account = await getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  if (!account.liff_id) {
    return c.json({ success: false, error: 'LIFF ID is required for candidate preview' }, 409);
  }
  try {
    const candidate = await loadPharmacyRichMenuCandidate(c, accountId);
    const input = buildPharmacyCatalogRichMenu(
      accountId, account.liff_id, candidate.effectiveOrder, 'Candidate',
    );
    const areas = input.pages[0]?.areas ?? [];
    const sync = await compareCandidateWithCurrent(
      c, accountId, areas, candidate.catalog.imageHash,
    );
    return c.json({
      success: true,
      data: {
        accountId,
        preferredOrder: candidate.layout.preferredOrder,
        effectiveOrder: candidate.effectiveOrder,
        layoutRevision: candidate.layout.revision,
        capabilityRevision: candidate.capabilities.revision,
        catalogVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
        variantKey: candidate.catalog.variantKey,
        menuSize: candidate.catalog.size,
        width: candidate.catalog.width,
        height: candidate.catalog.height,
        imageHash: candidate.catalog.imageHash,
        slots: getPharmacyRichMenuCatalogPreview(account.liff_id, candidate.effectiveOrder),
        ...sync,
      },
    });
  } catch (error) {
    if (String(error).includes('capability config not found')) {
      return c.json({ success: false, error: 'pharmacy config not found' }, 404);
    }
    return c.json({
      success: false,
      error: 'pharmacy rich-menu catalog is unavailable',
      data: { reasonCodes: ['RICH_MENU_CATALOG_UNVERIFIED'] },
    }, 409);
  }
});

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/candidate/image', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  const layoutRevision = Number(c.req.query('layoutRevision'));
  const capabilityRevision = Number(c.req.query('capabilityRevision'));
  const imageHash = c.req.query('imageHash');
  if (!accountId || !Number.isInteger(layoutRevision) || layoutRevision < 0 ||
      !Number.isInteger(capabilityRevision) || capabilityRevision < 1 ||
      !imageHash || !/^[a-f0-9]{64}$/u.test(imageHash)) {
    return c.json({ success: false, error: 'candidate evidence is required' }, 400);
  }
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  try {
    const candidate = await loadPharmacyRichMenuCandidate(c, accountId, {
      layoutRevision, capabilityRevision,
    });
    if (candidate.catalog.imageHash !== imageHash) {
      return c.json({ success: false, error: 'stale pharmacy rich-menu candidate image' }, 409);
    }
    return new Response(candidate.catalog.bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        ETag: `"${candidate.catalog.imageHash}"`,
      },
    });
  } catch {
    return c.json({ success: false, error: 'stale or unavailable pharmacy rich-menu candidate' }, 409);
  }
});

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/lifecycle', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  return c.json({
    success: true,
    data: await getPharmacyRichMenuLifecycleControl(c.env.DB, accountId),
  });
});

pharmacyRichMenuRoutes.put('/api/custom/pharmacy/rich-menus/lifecycle', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!canMutatePharmacyRichMenu(c) || !await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  let body: { state?: unknown; expectedRevision?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'valid JSON body required' }, 400);
  }
  if (!['inactive', 'active', 'frozen'].includes(String(body.state)) ||
      !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return c.json({ success: false, error: 'state and expectedRevision are required' }, 400);
  }
  try {
    return c.json({
      success: true,
      data: await savePharmacyRichMenuLifecycleControl(
        c.env.DB,
        accountId,
        body.state as 'inactive' | 'active' | 'frozen',
        Number(body.expectedRevision),
      ),
    });
  } catch (error) {
    if (String(error).includes('stale pharmacy rich-menu lifecycle revision')) {
      return c.json({ success: false, error: 'stale pharmacy rich-menu lifecycle revision' }, 409);
    }
    throw error;
  }
});

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/versions', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  return c.json({
    success: true,
    data: await listPharmacyRichMenuVersions(c.env.DB, accountId),
  });
});

pharmacyRichMenuRoutes.get('/api/custom/pharmacy/rich-menus/versions/:groupId/diff', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const checkedAt = new Date();
  const freshAfter = new Date(
    checkedAt.getTime() - EVIDENCE_FRESHNESS_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const [versions, evidence] = await Promise.all([
    listPharmacyRichMenuVersions(c.env.DB, accountId),
    getPharmacyRichMenuCurrentDefaultEvidence(c.env.DB, accountId, freshAfter),
  ]);
  const draft = versions.find((version) => version.groupId === c.req.param('groupId'));
  if (!draft) return c.json({ success: false, error: 'not found' }, 404);
  if (!evidence) {
    return c.json({
      success: true,
      data: {
        status: 'UNVERIFIED',
        accountId,
        checkedAt: checkedAt.toISOString(),
        freshnessHours: EVIDENCE_FRESHNESS_HOURS,
        reasonCode: 'CURRENT_DEFAULT_EVIDENCE_STALE',
      },
    });
  }
  const current = versions.find((version) => version.groupId === evidence.groupId);
  if (!current) {
    return c.json({
      success: true,
      data: {
        status: 'UNVERIFIED',
        accountId,
        checkedAt: checkedAt.toISOString(),
        freshnessHours: EVIDENCE_FRESHNESS_HOURS,
        reasonCode: 'CURRENT_DEFAULT_VERSION_MISSING',
      },
    });
  }

  const [currentGroup, draftGroup] = evidence.groupId === draft.groupId
    ? await getRichMenuGroupWithPages(c.env.DB, draft.groupId).then((group) => [group, group])
    : await Promise.all([
      getRichMenuGroupWithPages(c.env.DB, evidence.groupId),
      getRichMenuGroupWithPages(c.env.DB, draft.groupId),
    ]);
  if (!draftGroup || draftGroup.account_id !== accountId) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  if (!currentGroup || currentGroup.account_id !== accountId) {
    return c.json({
      success: true,
      data: {
        status: 'UNVERIFIED',
        accountId,
        checkedAt: checkedAt.toISOString(),
        freshnessHours: EVIDENCE_FRESHNESS_HOURS,
        reasonCode: 'CURRENT_DEFAULT_MANIFEST_UNAVAILABLE',
      },
    });
  }
  const currentAreas = groupManifestAreas(currentGroup);
  const draftAreas = groupManifestAreas(draftGroup);
  if (!currentAreas || !draftAreas) {
    return c.json({ success: false, error: 'saved rich-menu manifest unavailable' }, 409);
  }
  const diff = diffPharmacyRichMenuManifests(
    currentAreas, draftAreas, current.imageHash, draft.imageHash,
  );
  return c.json({
    success: true,
    data: {
      status: 'VERIFIED',
      accountId,
      checkedAt: checkedAt.toISOString(),
      freshnessHours: EVIDENCE_FRESHNESS_HOURS,
      verifiedAt: evidence.verifiedAt,
      current: {
        groupId: current.groupId,
        layoutRevision: current.layoutRevision,
        capabilityRevision: current.capabilityRevision,
        manifestHash: current.manifestHash,
        imageHash: current.imageHash,
      },
      draft: {
        groupId: draft.groupId,
        layoutRevision: draft.layoutRevision,
        capabilityRevision: draft.capabilityRevision,
        manifestHash: draft.manifestHash,
        imageHash: draft.imageHash,
      },
      ...diff,
    },
  });
});

pharmacyRichMenuRoutes.patch('/api/custom/pharmacy/rich-menus/versions/:groupId', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!canMutatePharmacyRichMenu(c) || !await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  let body: { name?: unknown; expectedUpdatedAt?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'valid JSON body required' }, 400);
  }
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 ||
      typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    return c.json({ success: false, error: 'name and expectedUpdatedAt are required' }, 400);
  }
  try {
    return c.json({
      success: true,
      data: await renamePharmacyRichMenuVersion(
        c.env.DB,
        accountId,
        c.req.param('groupId'),
        body.name,
        body.expectedUpdatedAt,
      ),
    });
  } catch (error) {
    if (String(error).includes('stale pharmacy rich-menu version metadata')) {
      return c.json({ success: false, error: 'stale pharmacy rich-menu version metadata' }, 409);
    }
    throw error;
  }
});

pharmacyRichMenuRoutes.delete('/api/custom/pharmacy/rich-menus/versions/:groupId', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  const expectedUpdatedAt = c.req.query('expectedUpdatedAt');
  if (!accountId || !expectedUpdatedAt) {
    return c.json({
      success: false, error: 'accountId and expectedUpdatedAt query params are required',
    }, 400);
  }
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!canMutatePharmacyRichMenu(c) || !await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  try {
    const deleted = await deletePharmacyRichMenuVersion(
      c.env.DB, accountId, c.req.param('groupId'), expectedUpdatedAt,
    );
    try {
      await c.env.IMAGES.delete(deleted.imageR2Key);
      return c.json({ success: true, data: { cleanupPending: false } });
    } catch {
      return c.json({ success: true, data: { cleanupPending: true } });
    }
  } catch (error) {
    if (String(error).includes('protected pharmacy rich-menu version')) {
      return c.json({ success: false, error: 'protected pharmacy rich-menu version' }, 409);
    }
    throw error;
  }
});

pharmacyRichMenuRoutes.post('/api/custom/pharmacy/rich-menus/versions', async (c) => {
  if (c.get('platformAdmin')) return c.json({ success: false, error: 'Forbidden' }, 403);
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!canMutatePharmacyRichMenu(c) || !await canAccessPharmacyRichMenu(c, accountId)) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  let body: {
    name?: unknown;
    expectedLayoutRevision?: unknown;
    expectedCapabilityRevision?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'valid JSON body required' }, 400);
  }
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 ||
      !Number.isInteger(body.expectedLayoutRevision) || Number(body.expectedLayoutRevision) < 1 ||
      !Number.isInteger(body.expectedCapabilityRevision) || Number(body.expectedCapabilityRevision) < 1) {
    return c.json({
      success: false,
      error: 'name, expectedLayoutRevision, and expectedCapabilityRevision are required',
    }, 400);
  }
  const [layout, capabilities] = await Promise.all([
    getPharmacyRichMenuLayout(c.env.DB, accountId),
    getPharmacyCapabilityConfig(c.env.DB, accountId),
  ]);
  if (!capabilities) return c.json({ success: false, error: 'pharmacy config not found' }, 404);
  if (layout.revision !== Number(body.expectedLayoutRevision) ||
      capabilities.revision !== Number(body.expectedCapabilityRevision)) {
    return c.json({ success: false, error: 'pharmacy rich-menu source revision is stale' }, 409);
  }
  const account = await getLineAccountByIdForTenant(c.env.DB, c.get('tenantId'), accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  if (!account.liff_id) {
    return c.json({ success: false, error: 'LIFF ID is required before preparing the pharmacy menu' }, 409);
  }
  const { effectiveOrder } = derivePharmacyRichMenuLayout(
    layout.preferredOrder, capabilities.capabilities,
  );
  const catalogImage = await loadPharmacyRichMenuCatalogImage(c.env.IMAGES, effectiveOrder);
  const input = buildPharmacyCatalogRichMenu(accountId, account.liff_id, effectiveOrder, body.name);
  const manifestHash = await hashPharmacyRichMenuManifest(input.pages[0]?.areas ?? []);
  const liffIdHash = await sha256Hex(account.liff_id);
  const created = await createRichMenuGroup(c.env.DB, input);
  const page = created.pages[0];
  if (!page) {
    await deleteRichMenuGroup(c.env.DB, created.id);
    return c.json({ success: false, error: 'created pharmacy rich-menu has no page' }, 500);
  }
  let imageR2Key: string | null = null;
  try {
    const stored = await savePharmacyRichMenuImage({
      db: c.env.DB,
      images: c.env.IMAGES,
      accountId,
      groupId: created.id,
      pageId: page.id,
      fileName: `${catalogImage.variantKey}.jpg`,
      contentType: 'image/jpeg',
      bytes: catalogImage.bytes,
      expectedSize: catalogImage.size,
    });
    imageR2Key = stored.imageR2Key;
    await createPharmacyRichMenuDraftBinding(c.env.DB, {
      groupId: created.id,
      lineAccountId: accountId,
      layoutRevision: layout.revision,
      capabilityRevision: capabilities.revision,
      liffIdHash,
      catalogVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
      menuSize: catalogImage.size,
      catalogVariantKey: catalogImage.variantKey,
      catalogObjectKey: catalogImage.objectKey,
      manifestHash,
      imageHash: catalogImage.imageHash,
    });
  } catch (error) {
    if (imageR2Key) await c.env.IMAGES.delete(imageR2Key).catch(() => undefined);
    await deleteRichMenuGroup(c.env.DB, created.id);
    throw error;
  }
  return c.json({
    success: true,
    data: {
      groupId: created.id,
      name: input.name,
      status: 'draft',
      catalogVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
      menuSize: catalogImage.size,
      catalogVariantKey: catalogImage.variantKey,
      imageHash: catalogImage.imageHash,
      manifestHash,
      layoutRevision: layout.revision,
      capabilityRevision: capabilities.revision,
      imageR2Key,
    },
  }, 201);
});

pharmacyRichMenuRoutes.post('/api/custom/pharmacy/rich-menus/prepare', (c) => {
  return c.json({
    success: false,
    error: 'pharmacy rich-menu prepare was retired; create a saved version instead',
  }, 410);
});
