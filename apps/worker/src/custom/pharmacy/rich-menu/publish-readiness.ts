import type { RichMenuAreaInput, RichMenuGroupWithPages } from '@line-crm/db';
import { validateRichMenuImage } from '../../../lib/image-validator.js';
import { getPharmacyCapabilityConfig } from '../growth-loop/repository.js';
import { loadPharmacyRichMenuCatalogImage, PHARMACY_RICH_MENU_CATALOG_VERSION } from './catalog.js';
import { derivePharmacyRichMenuLayout } from './layout.js';
import { diagnosePharmacyRichMenuActions, hashPharmacyRichMenuManifest } from './profile.js';
import {
  getPharmacyRichMenuDraftBinding,
  getPharmacyRichMenuLayout,
} from './repository.js';

export type PharmacyRichMenuPublishReadiness = {
  status: 'READY' | 'BLOCKED';
  reasonCodes: string[];
  evidenceDigest: string | null;
};

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function blocked(reasonCodes: string[]): PharmacyRichMenuPublishReadiness {
  return { status: 'BLOCKED', reasonCodes: [...new Set(reasonCodes)], evidenceDigest: null };
}

export async function getPharmacyRichMenuPublishReadiness(input: {
  db: D1Database;
  images: R2Bucket;
  accountId: string;
  liffId: string;
  group: RichMenuGroupWithPages;
  requiredStatus?: 'draft' | 'published';
}): Promise<PharmacyRichMenuPublishReadiness> {
  const requiredStatus = input.requiredStatus ?? 'draft';
  const [binding, layout, capabilities, currentLiffHash] = await Promise.all([
    getPharmacyRichMenuDraftBinding(input.db, input.accountId, input.group.id),
    getPharmacyRichMenuLayout(input.db, input.accountId),
    getPharmacyCapabilityConfig(input.db, input.accountId),
    sha256(input.liffId),
  ]);
  if (!binding) return blocked(['VERSION_BINDING_MISSING']);
  const reasons: string[] = [];
  if (input.group.account_id !== input.accountId) reasons.push('ACCOUNT_MISMATCH');
  if (input.group.status !== requiredStatus) {
    reasons.push(requiredStatus === 'draft' ? 'VERSION_NOT_DRAFT' : 'VERSION_NOT_PUBLISHED');
  }
  if (input.group.size !== binding.menuSize) reasons.push('MENU_SIZE_CHANGED');
  if (layout.revision !== binding.layoutRevision) reasons.push('LAYOUT_REVISION_STALE');
  if (!capabilities || capabilities.revision !== binding.capabilityRevision) {
    reasons.push('CAPABILITY_REVISION_STALE');
  }
  if (currentLiffHash !== binding.liffIdHash) reasons.push('LIFF_CONFIG_STALE');
  if (binding.catalogVersion !== PHARMACY_RICH_MENU_CATALOG_VERSION) reasons.push('CATALOG_VERSION_STALE');
  if (reasons.length > 0 || !capabilities) return blocked(reasons);

  const { effectiveOrder, variantKey } = derivePharmacyRichMenuLayout(
    layout.preferredOrder, capabilities.capabilities,
  );
  if (variantKey !== binding.catalogVariantKey) return blocked(['CATALOG_VARIANT_STALE']);
  const page = input.group.pages.find((candidate) => candidate.id === input.group.default_page_id) ??
    input.group.pages[0];
  if (input.group.pages.length !== 1 || !page?.image_r2_key || page.image_content_type !== 'image/jpeg' ||
      !page.image_r2_key.startsWith(`rich-menus/${input.accountId}/${input.group.id}/`)) {
    return blocked(['SAVED_IMAGE_BINDING_INVALID']);
  }
  const areas: RichMenuAreaInput[] = page.areas.map((area) => ({
    boundsX: area.bounds_x,
    boundsY: area.bounds_y,
    boundsWidth: area.bounds_width,
    boundsHeight: area.bounds_height,
    actionType: area.action_type,
    actionData: area.actionData,
  }));
  reasons.push(...diagnosePharmacyRichMenuActions(areas, input.liffId, effectiveOrder));
  if (await hashPharmacyRichMenuManifest(areas) !== binding.manifestHash) {
    reasons.push('ACTION_MANIFEST_CHANGED');
  }

  let catalogImage: Awaited<ReturnType<typeof loadPharmacyRichMenuCatalogImage>>;
  try {
    catalogImage = await loadPharmacyRichMenuCatalogImage(input.images, effectiveOrder);
  } catch {
    return blocked([...reasons, 'CATALOG_UNVERIFIED']);
  }
  if (catalogImage.objectKey !== binding.catalogObjectKey || catalogImage.imageHash !== binding.imageHash ||
      catalogImage.size !== binding.menuSize) {
    reasons.push('CATALOG_BINDING_CHANGED');
  }
  let saved: R2ObjectBody | null;
  try {
    saved = await input.images.get(page.image_r2_key);
  } catch {
    return blocked([...reasons, 'SAVED_IMAGE_UNVERIFIED']);
  }
  if (!saved) return blocked([...reasons, 'SAVED_IMAGE_MISSING']);
  const bytes = new Uint8Array(await saved.arrayBuffer());
  const validation = validateRichMenuImage(bytes, bytes.byteLength);
  if (saved.httpMetadata?.contentType !== 'image/jpeg' || !validation.ok ||
      validation.size !== binding.menuSize || validation.format !== 'jpeg' ||
      await sha256(bytes) !== binding.imageHash) {
    reasons.push('SAVED_IMAGE_CHANGED');
  }
  if (reasons.length > 0) return blocked(reasons);
  return {
    status: 'READY',
    reasonCodes: [],
    evidenceDigest: await sha256(JSON.stringify({
      groupId: input.group.id,
      groupStatus: input.group.status,
      groupUpdatedAt: input.group.updated_at,
      layoutRevision: binding.layoutRevision,
      capabilityRevision: binding.capabilityRevision,
      liffIdHash: binding.liffIdHash,
      catalogVersion: binding.catalogVersion,
      menuSize: binding.menuSize,
      catalogVariantKey: binding.catalogVariantKey,
      manifestHash: binding.manifestHash,
      imageHash: binding.imageHash,
    })),
  };
}
