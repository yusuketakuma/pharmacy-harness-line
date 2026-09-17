import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  DRAFT_TTL_MS,
  draftRestoreMessage,
  intakeDraftKey,
  loadDraft,
  NEW_PATIENT_DRAFT_KEY,
  newPatientDraftKey,
  saveDraft,
  sweepIntakeDrafts,
} from './draftStorage.js';

// V036-13: draft trust — savedAt envelope, 24h TTL, legacy restore-once,
// per-patient isolation, and fail-soft storage.
const store = new Map<string, string>();
const fakeStorage = {
  get length() {
    return store.size;
  },
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal('window', { localStorage: fakeStorage });
  vi.restoreAllMocks();
});

const NOW = 1_800_000_000_000;

describe('draftStorage', () => {
  it('round-trips a draft inside a savedAt envelope', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    saveDraft('k', { answers: { a: 1 } });
    const loaded = loadDraft<{ answers: { a: number } }>('k', NOW);
    expect(loaded?.savedAt).toBe(NOW);
    expect(loaded?.data).toEqual({ answers: { a: 1 } });
  });

  it('restores a legacy draft once with unknown save time', () => {
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ answers: { a: 2 } }));
    const loaded = loadDraft<{ answers: { a: number } }>('k', NOW);
    expect(loaded?.savedAt).toBeNull();
    expect(loaded?.data).toEqual({ answers: { a: 2 } });
  });

  it('migrates a legacy draft to an envelope on the next save', () => {
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ answers: { a: 2 } }));
    const legacy = loadDraft<{ answers: { a: number } }>('k', NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    saveDraft('k', legacy!.data);
    const migrated = loadDraft<{ answers: { a: number } }>('k', NOW);
    expect(migrated?.savedAt).toBe(NOW);
    expect(migrated?.data).toEqual({ answers: { a: 2 } });
  });

  it('deletes an expired draft instead of restoring it', () => {
    const savedAt = NOW - DRAFT_TTL_MS - 1;
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ savedAt, data: { answers: {} } }));
    expect(loadDraft('k', NOW)).toBeNull();
    expect(store.has('pharmacy-liff-draft:v1:k')).toBe(false);
  });

  it('keeps a draft saved exactly within the TTL', () => {
    const savedAt = NOW - DRAFT_TTL_MS;
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ savedAt, data: 'x' }));
    expect(loadDraft<string>('k', NOW)?.data).toBe('x');
  });

  it('isolates drafts per patient key', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    saveDraft(intakeDraftKey('patient-a'), { answers: { who: 'a' } });
    saveDraft(intakeDraftKey('patient-b'), { answers: { who: 'b' } });
    expect(loadDraft<{ answers: { who: string } }>(intakeDraftKey('patient-a'), NOW)?.data.answers.who).toBe('a');
    expect(loadDraft<{ answers: { who: string } }>(intakeDraftKey('patient-b'), NOW)?.data.answers.who).toBe('b');
    clearDraft(intakeDraftKey('patient-a'));
    expect(loadDraft(intakeDraftKey('patient-a'), NOW)).toBeNull();
    expect(loadDraft(intakeDraftKey('patient-b'), NOW)).not.toBeNull();
  });

  it('fails soft when storage throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('quota'); },
        removeItem: () => { throw new Error('denied'); },
      },
    });
    expect(loadDraft('k')).toBeNull();
    expect(() => saveDraft('k', {})).not.toThrow();
    expect(() => clearDraft('k')).not.toThrow();
  });

  it('returns null for corrupt JSON', () => {
    store.set('pharmacy-liff-draft:v1:k', '{not json');
    expect(loadDraft('k')).toBeNull();
  });

  it('removes a corrupt envelope (data: null) instead of leaving litter', () => {
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ savedAt: NOW, data: null }));
    expect(loadDraft('k', NOW)).toBeNull();
    expect(store.has('pharmacy-liff-draft:v1:k')).toBe(false);
  });

  it('restores a draft with a future savedAt as unknown-time instead of expiring it', () => {
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ savedAt: NOW + 10_000, data: { a: 1 } }));
    const loaded = loadDraft<{ a: number }>('k', NOW);
    expect(loaded?.data).toEqual({ a: 1 });
    expect(loaded?.savedAt).toBeNull();
  });

  it('restores a draft with a non-finite savedAt as unknown-time', () => {
    store.set('pharmacy-liff-draft:v1:k', JSON.stringify({ savedAt: 'yesterday', data: 'x' }));
    const loaded = loadDraft<string>('k', NOW);
    expect(loaded?.data).toBe('x');
    expect(loaded?.savedAt).toBeNull();
  });

  it('sweeps intake drafts for patients no longer in the list', () => {
    store.set(`pharmacy-liff-draft:v1:intake:gone`, JSON.stringify({ savedAt: NOW, data: { a: 1 } }));
    store.set(`pharmacy-liff-draft:v1:intake:kept`, JSON.stringify({ savedAt: NOW, data: { a: 2 } }));
    store.set('pharmacy-liff-draft:v1:patient-profile:new:app', JSON.stringify({ savedAt: NOW, data: {} }));
    store.set('unrelated-key', 'x');
    sweepIntakeDrafts(new Set(['kept']));
    expect(store.has('pharmacy-liff-draft:v1:intake:gone')).toBe(false);
    expect(store.has('pharmacy-liff-draft:v1:intake:kept')).toBe(true);
    expect(store.has('pharmacy-liff-draft:v1:patient-profile:new:app')).toBe(true);
    expect(store.get('unrelated-key')).toBe('x');
  });

  it('scopes the new-patient draft key by liffId with the legacy key kept', () => {
    expect(newPatientDraftKey('app-1')).toBe('patient-profile:new:app-1');
    expect(newPatientDraftKey('app-2')).not.toBe(newPatientDraftKey('app-1'));
    expect(NEW_PATIENT_DRAFT_KEY).toBe('patient-profile:new');
  });
});

describe('draftRestoreMessage', () => {
  it('marks legacy drafts as unknown save time', () => {
    expect(draftRestoreMessage(null)).toContain('保存時刻は不明');
  });

  it('includes the save date and time for envelope drafts', () => {
    const message = draftRestoreMessage(new Date(2026, 8, 18, 14, 5).getTime());
    expect(message).toContain('9月18日');
    expect(message).toContain('14時05分');
  });
});

describe('draft key scoping', () => {
  it('never reuses the new-patient key for an existing patient', () => {
    expect(intakeDraftKey('abc')).not.toBe(NEW_PATIENT_DRAFT_KEY);
    expect(intakeDraftKey('abc')).toContain('abc');
  });
});
