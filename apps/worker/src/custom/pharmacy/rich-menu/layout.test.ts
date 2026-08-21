import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHARMACY_RICH_MENU_ORDER,
  derivePharmacyRichMenuLayout,
  getPharmacyRichMenuPresentation,
  listPharmacyRichMenuVariantOrders,
  validatePharmacyRichMenuPreferredOrder,
} from './layout.js';

describe('pharmacy rich-menu layout', () => {
  it('filters disabled tiles without forgetting their preferred positions', () => {
    const preferredOrder = [
      'pharmacy-info',
      'prescription-send',
      'manual-chat',
      'prescription-history',
      'medication-followup',
    ] as const;

    expect(derivePharmacyRichMenuLayout(preferredOrder, ['manual_chat', 'pharmacy_info'])).toEqual({
      effectiveOrder: ['pharmacy-info', 'manual-chat'],
      variantKey: 'v4-compact-pharmacy-info.manual-chat',
    });
    expect(derivePharmacyRichMenuLayout(preferredOrder, [
      'prescription_intake', 'medication_followup', 'manual_chat', 'pharmacy_info',
    ]).effectiveOrder).toEqual(preferredOrder);
  });

  it('uses every LINE menu size and removes empty cells from the saved image', () => {
    const expected = [
      { direct: 0, size: 'compact', cells: 1 },
      { direct: 1, size: 'compact', cells: 2 },
      { direct: 2, size: 'compact', cells: 3 },
      { direct: 3, size: 'large', cells: 4 },
      { direct: 4, size: 'large', cells: 5 },
      { direct: 5, size: 'large', cells: 6 },
    ] as const;

    for (const item of expected) {
      const presentation = getPharmacyRichMenuPresentation(
        DEFAULT_PHARMACY_RICH_MENU_ORDER.slice(0, item.direct),
      );
      expect(presentation).toMatchObject({ size: item.size });
      expect(presentation.bounds).toHaveLength(item.cells);
      expect(presentation.bounds.reduce((sum, area) => sum + area.width * area.height, 0))
        .toBe(2500 * (item.size === 'large' ? 1686 : 843));
    }
  });

  it('rejects incomplete, duplicate, and unknown preferred orders', () => {
    expect(() => validatePharmacyRichMenuPreferredOrder(DEFAULT_PHARMACY_RICH_MENU_ORDER.slice(1))).toThrow(/exactly/i);
    expect(() => validatePharmacyRichMenuPreferredOrder([
      'prescription-send', 'prescription-send', 'medication-followup', 'manual-chat', 'pharmacy-info',
    ])).toThrow(/duplicate/i);
    expect(() => validatePharmacyRichMenuPreferredOrder([
      'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'unknown',
    ])).toThrow(/unknown/i);
  });

  it('enumerates every legal ON/OFF and reorder variant exactly once', () => {
    const variants = listPharmacyRichMenuVariantOrders();
    const keys = variants.map((order) => derivePharmacyRichMenuLayout(
      validatePharmacyRichMenuPreferredOrder([
        ...order,
        ...DEFAULT_PHARMACY_RICH_MENU_ORDER.filter((key) => !order.includes(key)),
      ]),
      order.flatMap((key) => key === 'prescription-send' || key === 'prescription-history'
        ? ['prescription_intake' as const]
        : key === 'medication-followup'
          ? ['medication_followup' as const]
          : key === 'manual-chat'
            ? ['manual_chat' as const]
            : ['pharmacy_info' as const]),
    ).variantKey);

    expect(variants).toHaveLength(228);
    expect(new Set(keys).size).toBe(228);
    expect(variants).toContainEqual([]);
    expect(variants).toContainEqual([...DEFAULT_PHARMACY_RICH_MENU_ORDER]);
  });
});
