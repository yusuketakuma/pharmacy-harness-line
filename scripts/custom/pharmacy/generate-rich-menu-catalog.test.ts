import { describe, expect, it } from 'vitest';
import { buildPharmacyRichMenuCatalogJobs } from './generate-rich-menu-catalog.js';

describe('pharmacy rich-menu release catalog generator', () => {
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
