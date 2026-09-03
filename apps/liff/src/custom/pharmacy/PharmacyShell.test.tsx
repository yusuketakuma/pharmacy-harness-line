import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./request.js', () => ({ requestPharmacyJson: request }));
vi.mock('../../lib/liff-auth.js', () => ({ getLiffId: () => 'liff-a' }));

import {
  loadPharmacyAccess,
  PharmacyShellHeader,
  pharmacyLiffVersion,
} from './PharmacyShell.js';

describe('pharmacy LIFF common shell', () => {
  it('shows the pharmacy, screen, package version, and tenant-preserving back link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><PharmacyShellHeader
        accountName="みどり薬局"
        screenTitle="受付状況"
        liffId="2000000000-AbCdEfGh"
      /></MemoryRouter>,
    );
    expect(html).toContain('みどり薬局');
    expect(html).toContain('break-words');
    expect(html).not.toContain('truncate');
    expect(html).toContain('<h1');
    expect(html).toContain('受付状況');
    expect(html).toContain(`v${pharmacyLiffVersion}`);
    expect(html).toContain('class="sr-only">アプリバージョン ');
    expect(html).not.toContain('<span aria-label="アプリバージョン');
    expect(html).toContain('/pharmacy/menu?liffId=2000000000-AbCdEfGh');
    expect(html).toContain('すべての機能へ戻る');
  });

  it('uses pharmacy tokens and safe-area-aware shared controls', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('./PharmacyShell.tsx', import.meta.url), 'utf8');
    expect(css).toContain('--pharmacy-');
    expect(css).toContain('safe-area-inset-bottom');
    expect(source).toContain('pharmacy-shell');
  });

  it('keeps enabled features usable when the authenticated history projection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {
        accountName: 'みどり薬局', enabledFeatures: ['pharmacy_info'],
      } }),
    }));
    request.mockRejectedValueOnce(new Error('temporary'));
    await expect(loadPharmacyAccess()).resolves.toEqual({
      accountName: 'みどり薬局', enabledFeatures: ['pharmacy_info'], existingFeatures: [],
      existingError: '利用中の機能を確認できませんでした。',
    });
  });

  it('fails closed on config errors and keeps retry single-flight and keyboard reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false }),
    }));
    await expect(loadPharmacyAccess()).rejects.toThrow('invalid LIFF config');
    const source = readFileSync(new URL('./PharmacyShell.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (loadingRef.current) return;');
    expect(source).toContain('role="alert"');
    expect(source).toContain('tabIndex={-1}');
    expect(source).toContain('min-h-11');
    expect(source).toContain('再試行');
  });

  it('wraps every pharmacy route without changing generic LIFF routes', () => {
    const source = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
    expect(source.match(/<PharmacyPage/g)).toHaveLength(8);
    expect(source).toContain('<Route path="/booking" element={<Booking />} />');
    expect(source).toContain('screenTitle="緊急避妊薬"');
    expect(source).toContain('screenTitle="薬局情報"');
    const menu = readFileSync(new URL('./menu/MainMenuPage.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('min-[360px]:grid-cols-2');
  });
});
