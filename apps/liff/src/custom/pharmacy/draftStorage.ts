// Patient-side draft persistence. LIFF may be closed mid-entry (train, call,
// accidental swipe); unsent form input is kept in localStorage and restored on
// the next visit. Data stays on the patient's own device and is cleared on
// successful submit. Storage access is wrapped because WebView environments can
// deny localStorage.
const PREFIX = 'pharmacy-liff-draft:v1:';

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
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

export const intakeDraftKey = (patientId: string) => `intake:${patientId}`;
export const NEW_PATIENT_DRAFT_KEY = 'patient-profile:new';
