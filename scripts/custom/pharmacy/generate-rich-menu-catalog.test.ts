import { describe, expect, it } from 'vitest';
import {
  buildCatalogEncodingArgs,
  buildCompositeTileArgs,
  buildPharmacyRichMenuCatalogJobs,
} from './generate-rich-menu-catalog.js';

describe('pharmacy rich-menu release catalog generator', () => {
  it('keeps the complete catalog within its release upload budget', () => {
    expect(buildCatalogEncodingArgs('/tmp/menu.jpg')).toEqual([
      '-strip', '-interlace', 'Plane', '-quality', '60', '/tmp/menu.jpg',
    ]);
  });

  it('anchors composited tiles to their top-left bounds', () => {
    expect(buildCompositeTileArgs('/tmp/tile.png', {
      x: 0,
      y: 0,
      width: 833,
      height: 843,
    })).toEqual([
      '(', '/tmp/tile.png', '-resize', '833x843',
      '-background', '#f3fff8', '-gravity', 'center', '-extent', '833x843', ')',
      '-gravity', 'northwest', '-geometry', '+0+0', '-composite',
    ]);
  });

  it('builds 228 adaptive jobs across both LINE sizes without empty cells', () => {
    const jobs = buildPharmacyRichMenuCatalogJobs();

    expect(jobs).toHaveLength(228);
    expect(new Set(jobs.map((job) => job.variantKey)).size).toBe(228);
    expect(jobs.filter((job) => job.size === 'compact')).toHaveLength(12);
    expect(jobs.filter((job) => job.size === 'large')).toHaveLength(216);
    for (const job of jobs) {
      expect(job.cells).toEqual([...job.orderedActions, 'all-functions']);
      expect(job.bounds).toHaveLength(job.cells.length);
    }
  });
});
