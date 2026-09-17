// Patient-side draft persistence. LIFF may be closed mid-entry (train, call,
// accidental swipe); unsent form input is kept in localStorage and restored on
// the next visit. Data stays on the patient's own device and is cleared on
// successful submit. Storage access is wrapped because WebView environments can
// deny localStorage.
const PREFIX = 'pharmacy-liff-draft:v1:';
const INTAKE_PREFIX = `${PREFIX}intake:`;

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
      if (parsed.data === null || parsed.data === undefined) {
        // Corrupt envelope — restore nothing and remove the litter so it
        // cannot sit in storage forever.
        window.localStorage.removeItem(PREFIX + key);
        return null;
      }
      // Only a finite past timestamp is a trustworthy save time. A future or
      // non-finite savedAt is treated as unknown (restored, never expired by
      // a clock-skewed write) rather than as a reason to drop patient input.
      const savedAt =
        typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) && parsed.savedAt <= now
          ? parsed.savedAt
          : null;
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

// Drafts for patients that disappear from the patient list (deleted or proxy
// revoked) are never read again, so the lazy TTL in loadDraft would keep them
// forever. The intake page sweeps them whenever it loads the patient list —
// the list is the authoritative scope of "who can still have a draft".
export function sweepIntakeDrafts(validPatientIds: ReadonlySet<string>): void {
  try {
    const storage = window.localStorage;
    const staleKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(INTAKE_PREFIX)) continue;
      const patientId = key.slice(INTAKE_PREFIX.length);
      if (!validPatientIds.has(patientId)) staleKeys.push(key);
    }
    for (const key of staleKeys) storage.removeItem(key);
  } catch {
    // Enumeration unavailable — lazy cleanup on read still applies.
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
// LIFF apps for different pharmacy accounts may share one Pages origin, so the
// new-patient draft is scoped by liffId to avoid restoring another account's
// draft. NEW_PATIENT_DRAFT_KEY is the pre-scoping legacy key kept for
// restore-once compatibility.
export const newPatientDraftKey = (liffId: string) => `patient-profile:new:${liffId}`;
export const NEW_PATIENT_DRAFT_KEY = 'patient-profile:new';
