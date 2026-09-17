// Patient-side draft persistence. LIFF may be closed mid-entry (train, call,
// accidental swipe); unsent form input is kept in localStorage and restored on
// the next visit. Data stays on the patient's own device and is cleared on
// successful submit. Storage access is wrapped because WebView environments can
// deny localStorage.
const PREFIX = 'pharmacy-liff-draft:v1:';

// Engineering trade-off, not a legal value: long enough to survive a session
// interruption, short enough to limit PHI left on a shared device.
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface LoadedDraft<T> {
  data: T;
  /** Epoch ms the draft was last saved; null for legacy drafts that predate the envelope. */
  savedAt: number | null;
}

interface DraftEnvelope {
  savedAt: unknown;
  data: unknown;
}

function isEnvelope(value: unknown): value is DraftEnvelope {
  return value !== null && typeof value === 'object' && 'savedAt' in value && 'data' in value;
}

export function loadDraft<T>(key: string, now: number = Date.now()): LoadedDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return null;
    if (isEnvelope(parsed)) {
      if (parsed.data === null || parsed.data === undefined) return null;
      const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
      if (savedAt !== null && now - savedAt > DRAFT_TTL_MS) {
        // Expired drafts are deleted and never restored.
        window.localStorage.removeItem(PREFIX + key);
        return null;
      }
      return { data: parsed.data as T, savedAt };
    }
    // Legacy draft (no envelope): restore once with unknown save time; the
    // next edit rewrites it in envelope form.
    return { data: parsed as T, savedAt: null };
  } catch {
    return null;
  }
}

export function saveDraft(key: string, value: unknown): void {
  try {
    // codeql[js/clear-text-storage-of-sensitive-data]: intentional feature —
    // unsent form drafts persist only on the patient's own device (LIFF
    // localStorage), are keyed per patient, expire after DRAFT_TTL_MS, are
    // cleared on submit, and are never transmitted outside the existing
    // submit path.
    const envelope = { savedAt: Date.now(), data: value };
    window.localStorage.setItem(PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Storage unavailable (private mode / quota) — the form still works.
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** Patient-facing label shown only when a draft was actually restored. */
export function draftRestoreMessage(savedAt: number | null): string {
  if (savedAt === null) return '下書きを復元しました（保存時刻は不明です）。';
  const date = new Date(savedAt);
  const stamp = `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}時${String(date.getMinutes()).padStart(2, '0')}分`;
  return `下書きを復元しました（${stamp}に保存）。`;
}

export const intakeDraftKey = (patientId: string) => `intake:${patientId}`;
export const NEW_PATIENT_DRAFT_KEY = 'patient-profile:new';
