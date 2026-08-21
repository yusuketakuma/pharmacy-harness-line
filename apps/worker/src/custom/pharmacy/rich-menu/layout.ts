import type { PharmacyCapability } from '../growth-loop/access.js';

export const DEFAULT_PHARMACY_RICH_MENU_ORDER = [
  'prescription-send',
  'prescription-history',
  'medication-followup',
  'manual-chat',
  'pharmacy-info',
] as const;

export type PharmacyRichMenuActionKey = (typeof DEFAULT_PHARMACY_RICH_MENU_ORDER)[number];
export type PharmacyRichMenuSize = 'large' | 'compact';
export type PharmacyRichMenuBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const COMPACT_BOUNDS: Record<1 | 2 | 3, PharmacyRichMenuBounds[]> = {
  1: [{ x: 0, y: 0, width: 2500, height: 843 }],
  2: [
    { x: 0, y: 0, width: 1250, height: 843 },
    { x: 1250, y: 0, width: 1250, height: 843 },
  ],
  3: [
    { x: 0, y: 0, width: 833, height: 843 },
    { x: 833, y: 0, width: 834, height: 843 },
    { x: 1667, y: 0, width: 833, height: 843 },
  ],
};

const LARGE_BOUNDS: Record<4 | 5 | 6, PharmacyRichMenuBounds[]> = {
  4: [
    { x: 0, y: 0, width: 1250, height: 843 },
    { x: 1250, y: 0, width: 1250, height: 843 },
    { x: 0, y: 843, width: 1250, height: 843 },
    { x: 1250, y: 843, width: 1250, height: 843 },
  ],
  5: [
    { x: 0, y: 0, width: 1250, height: 843 },
    { x: 1250, y: 0, width: 1250, height: 843 },
    { x: 0, y: 843, width: 833, height: 843 },
    { x: 833, y: 843, width: 834, height: 843 },
    { x: 1667, y: 843, width: 833, height: 843 },
  ],
  6: [
    ...COMPACT_BOUNDS[3],
    ...COMPACT_BOUNDS[3].map((area) => ({ ...area, y: 843 })),
  ],
};

export function getPharmacyRichMenuPresentation(
  orderedActions: readonly PharmacyRichMenuActionKey[],
): {
  size: PharmacyRichMenuSize;
  width: 2500;
  height: 843 | 1686;
  bounds: PharmacyRichMenuBounds[];
  variantKey: string;
} {
  const cells = orderedActions.length + 1;
  if (cells < 1 || cells > 6) throw new Error('pharmacy rich-menu must contain 1-6 cells');
  const size = cells <= 3 ? 'compact' : 'large';
  const bounds = cells <= 3
    ? COMPACT_BOUNDS[cells as 1 | 2 | 3]
    : LARGE_BOUNDS[cells as 4 | 5 | 6];
  return {
    size,
    width: 2500,
    height: size === 'compact' ? 843 : 1686,
    bounds: bounds.map((area) => ({ ...area })),
    variantKey: `v4-${size}-${orderedActions.length === 0 ? 'empty' : orderedActions.join('.')}`,
  };
}

const CAPABILITY_BY_ACTION: Record<PharmacyRichMenuActionKey, PharmacyCapability> = {
  'prescription-send': 'prescription_intake',
  'prescription-history': 'prescription_intake',
  'medication-followup': 'medication_followup',
  'manual-chat': 'manual_chat',
  'pharmacy-info': 'pharmacy_info',
};

const DIRECT_CAPABILITIES = [
  'prescription_intake',
  'medication_followup',
  'manual_chat',
  'pharmacy_info',
] as const satisfies readonly PharmacyCapability[];

export function validatePharmacyRichMenuPreferredOrder(value: readonly string[]): PharmacyRichMenuActionKey[] {
  if (value.length !== DEFAULT_PHARMACY_RICH_MENU_ORDER.length) {
    throw new Error('preferred order must contain exactly five actions');
  }
  if (value.some((key) => !(DEFAULT_PHARMACY_RICH_MENU_ORDER as readonly string[]).includes(key))) {
    throw new Error('preferred order contains an unknown action');
  }
  if (new Set(value).size !== value.length) {
    throw new Error('preferred order contains a duplicate action');
  }
  return [...value] as PharmacyRichMenuActionKey[];
}

export function derivePharmacyRichMenuLayout(
  preferredOrder: readonly string[],
  capabilities: readonly PharmacyCapability[],
): { effectiveOrder: PharmacyRichMenuActionKey[]; variantKey: string } {
  const validatedOrder = validatePharmacyRichMenuPreferredOrder(preferredOrder);
  const enabled = new Set(capabilities);
  const effectiveOrder = validatedOrder.filter((key) => enabled.has(CAPABILITY_BY_ACTION[key]));
  return {
    effectiveOrder,
    variantKey: getPharmacyRichMenuPresentation(effectiveOrder).variantKey,
  };
}

function permutations(values: readonly PharmacyRichMenuActionKey[]): PharmacyRichMenuActionKey[][] {
  // ponytail: factorial work is bounded to five release-only tiles; replace if the allowlist grows.
  if (values.length < 2) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((rest) => [value, ...rest]));
}

export function listPharmacyRichMenuVariantOrders(): PharmacyRichMenuActionKey[][] {
  const variants: PharmacyRichMenuActionKey[][] = [];
  for (let mask = 0; mask < 1 << DIRECT_CAPABILITIES.length; mask += 1) {
    const enabled = new Set<PharmacyCapability>(
      DIRECT_CAPABILITIES.filter((_, index) => mask & (1 << index)),
    );
    const actions = DEFAULT_PHARMACY_RICH_MENU_ORDER.filter((key) => enabled.has(CAPABILITY_BY_ACTION[key]));
    variants.push(...permutations(actions));
  }
  return variants;
}
