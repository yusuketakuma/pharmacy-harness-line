import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createRichMenuGroup,
  getLineAccountById,
  getRichMenuGroupByGeneratorKey,
  getRichMenuGroupWithPages,
  type RichMenuGroupWithPages,
} from '@line-crm/db';
import type { Env } from '../../../index.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from '../growth-loop/access.js';
import {
  buildPharmacyInitialRichMenu,
  buildPharmacySingleActionRichMenu,
  isPharmacyInitialRichMenuProfile,
  PHARMACY_INITIAL_PROFILE_KEY,
  PHARMACY_SINGLE_ACTION_PROFILE_KEY,
  PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH,
  PHARMACY_SINGLE_ACTION_RICH_MENU_IMAGE_PATH,
  PHARMACY_RICH_MENU_GENERATOR_VERSION,
} from './profile.js';
import { savePharmacyRichMenuImage } from './storage.js';

export const pharmacyRichMenuRoutes = new Hono<Env>();

function serializeGroup(group: RichMenuGroupWithPages) {
  return {
    id: group.id,
    accountId: group.account_id,
    name: group.name,
    chatBarText: group.chat_bar_text,
    size: group.size,
    defaultPageId: group.default_page_id,
    isDefaultForAll: group.is_default_for_all === 1,
    selected: group.selected === 1,
    status: group.status,
    generatorKey: group.generator_key,
    generatorVersion: group.generator_version,
    publishingAt: group.publishing_at,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
    pages: group.pages.map((page) => ({
      id: page.id,
      orderIndex: page.order_index,
      name: page.name,
      aliasId: page.alias_id,
      lineRichmenuId: page.line_richmenu_id,
      imageR2Key: page.image_r2_key,
      imageContentType: page.image_content_type,
      areas: page.areas.map((area) => ({
        id: area.id,
        boundsX: area.bounds_x,
        boundsY: area.bounds_y,
        boundsWidth: area.bounds_width,
        boundsHeight: area.bounds_height,
        actionType: area.action_type,
        actionData: area.actionData,
      })),
    })),
  };
}

async function loadInitialImage(c: Context<Env>, profileKey: string): Promise<Uint8Array> {
  const imagePath = profileKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY
    ? PHARMACY_SINGLE_ACTION_RICH_MENU_IMAGE_PATH
    : PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH;
  const response = await c.env.ASSETS.fetch(
    new Request(new URL(imagePath, c.req.url)),
  );
  if (!response.ok) throw new Error('initial pharmacy rich-menu image asset is unavailable');
  return new Uint8Array(await response.arrayBuffer());
}

async function attachInitialImage(
  c: Context<Env>,
  accountId: string,
  group: RichMenuGroupWithPages,
  profileKey: string,
): Promise<boolean> {
  const page = group.pages[0];
  if (!page || page.image_r2_key) return !!page?.image_r2_key;
  const image = await loadInitialImage(c, profileKey);
  const fileName = profileKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY
    ? 'initial-single-action-v1.jpg'
    : 'initial-compact-3x1.jpg';
  await savePharmacyRichMenuImage({
    db: c.env.DB,
    images: c.env.IMAGES,
    accountId,
    groupId: group.id,
    pageId: page.id,
    fileName,
    contentType: 'image/jpeg',
    bytes: image,
    expectedSize: 'compact',
  });
  return true;
}

pharmacyRichMenuRoutes.post('/api/custom/pharmacy/rich-menus/prepare', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyAccount(c.env.DB, staff, accountId)) ||
      !(await hasPharmacyCapability(c.env.DB, accountId, 'pharmacy_rich_menu'))) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  let body: { profileKey?: unknown; initial?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is the default initial profile.
  }
  const profileKey = typeof body.profileKey === 'string' ? body.profileKey : undefined;
  if (!isPharmacyInitialRichMenuProfile(profileKey)) {
    return c.json({ success: false, error: `unsupported pharmacy rich-menu profile: ${profileKey}` }, 400);
  }
  if (body.initial !== undefined && typeof body.initial !== 'boolean') {
    return c.json({ success: false, error: 'initial must be boolean' }, 400);
  }

  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return c.json({ success: false, error: 'line account not found' }, 404);
  if (!account.liff_id) {
    return c.json({ success: false, error: 'LIFF ID is required before preparing the pharmacy menu' }, 409);
  }

  const generatorKey = profileKey ?? PHARMACY_INITIAL_PROFILE_KEY;
  const existing = await getRichMenuGroupByGeneratorKey(
    c.env.DB,
    accountId,
    generatorKey,
  );
  if (existing) {
    const group = await getRichMenuGroupWithPages(c.env.DB, existing.id);
    if (!group) return c.json({ success: false, error: 'generated group disappeared' }, 500);
    const imageAttached = await attachInitialImage(c, accountId, group, generatorKey);
    const refreshed = imageAttached ? await getRichMenuGroupWithPages(c.env.DB, group.id) : group;
    if (!refreshed) return c.json({ success: false, error: 'generated group disappeared after image attach' }, 500);
    return c.json({
      success: true,
      data: {
        status: 'already_prepared',
        reused: true,
        imageAttached,
        group: serializeGroup(refreshed),
      },
    });
  }

  const input = generatorKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY
    ? buildPharmacySingleActionRichMenu(accountId, account.liff_id, body.initial === undefined ? false : body.initial === true)
    : buildPharmacyInitialRichMenu(accountId, account.liff_id);
  let created: RichMenuGroupWithPages;
  try {
    created = await createRichMenuGroup(c.env.DB, input);
  } catch (error) {
    // Two setup commands can race; the unique generator key makes the loser reuse the winner.
    if (!String(error).match(/unique|constraint/i)) throw error;
    const winner = await getRichMenuGroupByGeneratorKey(c.env.DB, accountId, generatorKey);
    if (!winner) throw error;
    const group = await getRichMenuGroupWithPages(c.env.DB, winner.id);
    if (!group) return c.json({ success: false, error: 'generated group disappeared' }, 500);
    const imageAttached = await attachInitialImage(c, accountId, group, generatorKey);
    const refreshed = imageAttached ? await getRichMenuGroupWithPages(c.env.DB, group.id) : group;
    if (!refreshed) return c.json({ success: false, error: 'generated group disappeared after image attach' }, 500);
    return c.json({
      success: true,
      data: { status: 'already_prepared', reused: true, imageAttached, group: serializeGroup(refreshed) },
    });
  }

  const imageAttached = await attachInitialImage(c, accountId, created, generatorKey);

  const refreshed = await getRichMenuGroupWithPages(c.env.DB, created.id);
  if (!refreshed) return c.json({ success: false, error: 'generated group disappeared after prepare' }, 500);
  return c.json({
    success: true,
    data: {
      status: 'prepared',
      reused: false,
      imageAttached,
      generatorVersion: PHARMACY_RICH_MENU_GENERATOR_VERSION,
      imagePath: generatorKey === PHARMACY_SINGLE_ACTION_PROFILE_KEY
        ? PHARMACY_SINGLE_ACTION_RICH_MENU_IMAGE_PATH
        : PHARMACY_INITIAL_RICH_MENU_IMAGE_PATH,
      group: serializeGroup(refreshed),
    },
  });
});
