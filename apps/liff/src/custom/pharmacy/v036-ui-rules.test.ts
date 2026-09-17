import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// V036-8: the audit found patient-facing text at text-sm and controls without a
// 44px tap target. This guard keeps the pharmacy seam compliant: body text is
// text-base or larger, and every button/link/select keeps a min-h-11 class or
// the pharmacy-control utility (which sets the same 2.75rem floor).
const SEAM_ROOT = new URL('.', import.meta.url).pathname;

function seamFiles(dir: string = SEAM_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return seamFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

// Small text that stays: annotation chips, shell chrome, nav tabs, and the
// pharmacy-supplemental class (which is the sanctioned small style).
const ALLOWED_SMALL_TEXT = [
  /text-sm font-bold text-red-800">必須/, // required badge chip
  /text-sm font-bold tracking-wide text-green-800">PHARMACY/, // wordmark
  /text-right text-sm text-gray-600">最終更新/, // metadata timestamp
  /break-words text-sm font-bold text-green-800/, // shell header account name
  /rounded-full bg-gray-100 px-2\.5 py-1 text-sm font-bold/, // shell version chip
  /text-center text-sm \$\{tab === view/, // prescriptions tab nav
  /absolute left-1 top-1 rounded px-2 py-1 text-sm font-bold/, // per-image send status chip
];

// Collect the opening tag only: accumulate lines from `start` until the line
// containing the tag-closing `>` (lookahead is bounded to the tag, not the
// surrounding markup).
function openingTag(lines: string[], start: number): string {
  let tag = '';
  for (let i = start; i < lines.length && i < start + 15; i += 1) {
    tag += `${lines[i]} `;
    // Ignore `=>` and `>=` inside attribute expressions.
    if (lines[i].replace(/=>|>=/g, '').includes('>')) break;
  }
  return tag;
}

describe('v0.36 patient UI rules', () => {
  it('covers every pharmacy seam screen file', () => {
    expect(seamFiles().length).toBeGreaterThanOrEqual(12);
  });

  it('keeps body text at text-base or larger across the pharmacy seam', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\btext-(xs|sm)\b/.test(line)) return;
        if (ALLOWED_SMALL_TEXT.some((allowed) => allowed.test(line))) return;
        violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps standalone tap targets at min-h-11 via class or pharmacy-control', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        const isInteractive =
          /<(?:button|Link|select|a)(?=[\s>]|$)/.test(line) ||
          // A label that wraps a radio/checkbox on the same line is itself the
          // tap target; plain text labels above fields are out of scope.
          (/<label(?=[\s>]|$)/.test(line) && /<input[^>]*type="(?:radio|checkbox)"/.test(line));
        if (!isInteractive) return;
        const tag = openingTag(lines, index);
        // fieldClass is a per-file shared constant; verify it keeps the floor.
        const usesSharedFieldClass = /className=\{fieldClass\}/.test(tag) &&
          /fieldClass = '[^']*min-h-1[12]/.test(source);
        if (/min-h-1[12]|pharmacy-control|sr-only/.test(tag) || usesSharedFieldClass) return;
        violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('pins the shared utility classes to the 44px floor', () => {
    const css = readFileSync(join(SEAM_ROOT, '../../index.css'), 'utf8');
    const control = css.match(/\.pharmacy-control\s*\{[^}]*\}/)?.[0] ?? '';
    expect(control).toMatch(/min-height:\s*2\.75rem/);
  });

  it('keeps the motion/feedback utilities and the reduced-motion opt-out', () => {
    const css = readFileSync(join(SEAM_ROOT, '../../index.css'), 'utf8');
    const animated = [
      'pharmacy-page-enter',
      'pharmacy-step-next',
      'pharmacy-step-back',
      'pharmacy-progress-bar',
      'pharmacy-skeleton',
      'pharmacy-spinner',
    ];
    for (const name of animated) {
      expect(css, `.${name} must exist`).toContain(`.${name}`);
    }
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/)?.[0] ?? '';
    expect(reduced).not.toBe('');
    for (const name of [...animated, 'pharmacy-control']) {
      expect(reduced, `.${name} must be disabled under reduced motion`).toContain(`.${name}`);
    }
  });

  it('resets scroll position and document.title on pharmacy route changes', () => {
    const shell = readFileSync(join(SEAM_ROOT, 'PharmacyShell.tsx'), 'utf8');
    expect(shell).toContain('window.scrollTo(0, 0)');
    expect(shell).toContain('document.title');
  });

  it('avoids native number/date inputs (spinner/scroll/calendar traps)', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/type="(?:number|date)"/.test(line)) return;
        // Recent-date pickers (last menstruation) are fine; the ban targets
        // remembered dates like birth dates, plus number spinners.
        if (/type="date"/.test(line) && lines.slice(Math.max(0, index - 3), index).join('\n').includes('emergency-last-period')) return;
        violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps text-entry fields at text-base (prevents iOS auto-zoom)', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        if (!/<(?:input|textarea|select)(?=[\s>]|$)/.test(line)) return;
        const tag = openingTag(lines, index);
        if (/type="(?:radio|checkbox|file|hidden|submit|button)"/.test(tag)) return;
        const usesSharedFieldClass = /className=\{fieldClass\}/.test(tag) &&
          /fieldClass = '[^']*text-base/.test(source);
        if (/text-(?:base|lg|xl|2xl)/.test(tag) || usesSharedFieldClass) return;
        violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps patient-facing text at gray-600 or darker (contrast)', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/text-gray-[45]00/.test(line)) violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('marks in-flight submissions with aria-busy wherever a spinner is shown', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('<PharmacySpinner')) continue;
      if (!/aria-busy=\{/.test(source)) violations.push(file.replace(SEAM_ROOT, ''));
    }
    expect(violations).toEqual([]);
  });

  // V036-12: auto-retry is per-load, read-only, and StrictMode-safe. The
  // attempt budget is consumed inside the setTimeout callback (never at
  // schedule time), every call site passes a named read callback, and pages
  // with several loads wire one hook per load family.
  it('spends a retry attempt only when its timer fires', () => {
    const source = readFileSync(join(SEAM_ROOT, 'feedback.tsx'), 'utf8');
    const hook = source.slice(source.indexOf('export function usePharmacyAutoRetry'));
    expect(hook).toMatch(/setTimeout\(\(\) => \{\s*attempts\.current \+= 1;\s*retryRef\.current\(\);/);
    expect(hook).toMatch(/clearTimeout\(timer\)/);
  });

  it('wires auto-retry and reconnect callbacks to named reads only (no mutation paths)', () => {
    const violations: string[] = [];
    let callCount = 0;
    for (const file of seamFiles()) {
      if (file.endsWith('feedback.tsx')) continue; // hook definition site
      const source = readFileSync(file, 'utf8');
      // Capture to the statement-ending `);` so arrow bodies with their own
      // parentheses (e.g. `() => void load(true)`) are seen whole.
      const calls = source.matchAll(/usePharmacy(AutoRetry|Online)\(([\s\S]*?)\)\s*;/g);
      for (const call of calls) {
        callCount += 1;
        const args = (call[2] ?? '').trim();
        const comma = args.indexOf(',');
        // AutoRetry's callback is arg2; Online's reconnect callback is arg1.
        const callback = (call[1] === 'Online'
          ? (comma === -1 ? args : args.slice(0, comma))
          : (comma === -1 ? '' : args.slice(comma + 1))).trim();
        // No argument (banner-only usage) is fine. A named read must carry a
        // read-style name; a thin arrow may only invoke named reads — never
        // inline state writes that could stomp an in-progress form.
        if (callback === '') continue;
        if (/^[A-Za-z_$][\w$]*$/.test(callback)) {
          if (!/load|refresh|retry|fetch|read/i.test(callback)) {
            violations.push(`${file.replace(SEAM_ROOT, '')} -> ${callback}`);
          }
          continue;
        }
        // Multi-statement arrows (`() => { ...; ... }`) are rejected outright:
        // the non-greedy capture would stop at the first `);` and hide the
        // rest of the body from the checks below.
        if (!callback.startsWith('()') || /[{;]/.test(callback)) {
          violations.push(`${file.replace(SEAM_ROOT, '')} -> ${callback}`);
          continue;
        }
        const invoked = [...callback.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
        const hasSetterOrAssign = /set[A-Z]|[^=!<>]=[^=>]/.test(callback.replace('=>', ''));
        if (invoked.length === 0 || invoked.some((name) => !/load|refresh|retry|fetch|read/i.test(name)) || hasSetterOrAssign) {
          violations.push(`${file.replace(SEAM_ROOT, '')} -> ${callback}`);
        }
      }
    }
    expect(callCount).toBeGreaterThanOrEqual(18);
    expect(violations).toEqual([]);
  });

  // A reconnect refresh must never stomp in-progress patient input: quiet
  // reads keep content mounted, recovery populate is gated, and consent
  // resets only when the underlying policy text actually changed.
  it('keeps background refreshes from overwriting in-progress form state', () => {
    const intake = readFileSync(join(SEAM_ROOT, 'intake/PatientIntakePage.tsx'), 'utf8');
    expect(intake).toMatch(/void loadPatients\(true\);\s*\n\s*void loadPrivacyPolicy\(\(\) => mountedRef\.current, true\)/);
    expect(intake).toMatch(/policyFingerprintRef\.current !== fingerprint[\s\S]*?setPrivacyConsent\(false\)/);
    expect(intake).toContain('newPatientDraftHandledRef.current');
    const prescriptions = readFileSync(join(SEAM_ROOT, 'prescriptions/PrescriptionPage.tsx'), 'utf8');
    // Recovery populate is fingerprint-gated: the same recoverable
    // submission is never re-copied over in-progress edits, and a quiet
    // failure keeps the last-known state instead of downgrading it.
    expect(prescriptions).toMatch(/recoveryAppliedRef\.current !== fingerprint/);
    expect(prescriptions).toContain('recoveryAppliedRef.current = fingerprint');
    expect(prescriptions).toContain("void refreshRecovery('auto', true)");
    expect(prescriptions).toContain('void loadPatients(true)');
    // Pages whose mutations write list state directly guard the refresh with
    // a load epoch, so a stale in-flight read cannot undo a just-applied
    // create/cancel/respond result.
    for (const file of [
      'emergency-contraception/EmergencyContraceptionPage.tsx',
      'medication-followup/MedicationFollowUpPage.tsx',
      'continuity/ContinuityPage.tsx',
    ]) {
      const page = readFileSync(join(SEAM_ROOT, file), 'utf8');
      expect(page, file).toMatch(/const epoch = \+\+loadEpochRef\.current/);
      expect(page, file).toMatch(/epoch !== loadEpochRef\.current/);
      expect(page, file).toMatch(/loadEpochRef\.current \+= 1/);
    }
  });

  // V036-16: each selected image shows its own send state; the upload
  // transport itself is untouched. V036-17: reconnect handling never reloads
  // the page — it re-runs named reads only.
  it('tracks per-image send states without changing the upload transport', () => {
    const source = readFileSync(join(SEAM_ROOT, 'prescriptions/PrescriptionPage.tsx'), 'utf8');
    for (const label of ['送信待ち', '送信中…', '送信済み', '要再試行']) {
      expect(source).toContain(label);
    }
    // The sequential upload call is unchanged — states wrap it, they do not
    // alter how bytes move.
    expect(source).toContain('await prescriptionApi.upload(submission.id, upload.position, upload.file)');
    expect(source).not.toContain('XMLHttpRequest');
  });

  it('never reloads the page to recover connectivity', () => {
    for (const file of seamFiles()) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/location\.reload|location\.href\s*=/);
    }
    const shell = readFileSync(join(SEAM_ROOT, 'PharmacyShell.tsx'), 'utf8');
    expect(shell).toContain('PharmacyOfflineBanner');
  });

  it('retries each load family independently on multi-load pages', () => {
    const count = (file: string) =>
      (readFileSync(join(SEAM_ROOT, file), 'utf8').match(/usePharmacyAutoRetry\(/g) ?? []).length;
    expect(count('prescriptions/PrescriptionPage.tsx')).toBeGreaterThanOrEqual(4);
    expect(count('intake/PatientIntakePage.tsx')).toBeGreaterThanOrEqual(2);
  });

  // V036-14: a live region (role=status/alert) must never also be the focus
  // target — screen readers would speak it once for the region change and
  // again for the focus. Focused blocks announce via focus; live regions
  // announce via the region. Neither may carry the other's channel.
  it('never marks a focus target as a live region', () => {
    const violations: string[] = [];
    for (const file of seamFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return; // comments may quote the rule
        if (!/tabIndex=\{-1\}|role="(?:alert|status)"/.test(line)) return;
        const tag = openingTag(lines, index);
        if (/tabIndex=\{-1\}/.test(tag) && /role="(?:alert|status)"/.test(tag)) {
          violations.push(`${file.replace(SEAM_ROOT, '')}:${index + 1}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  // V036-15: patient copy stays plain — medical/legal jargon is replaced or
  // glossed at first use, and the EC page keeps its domain term 仮受付 only
  // with an explanation attached.
  it('keeps patient-facing copy plain', () => {
    for (const file of seamFiles()) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('既往歴');
      expect(source, file).not.toContain('明示同意');
    }
    const ec = readFileSync(join(SEAM_ROOT, 'emergency-contraception/EmergencyContraceptionPage.tsx'), 'utf8');
    expect(ec).toContain('仮受付（確定前のお申し込み）');
  });

  it('scopes aria-busy to the exact in-flight control', () => {
    const source = readFileSync(join(SEAM_ROOT, 'medication-followup/MedicationFollowUpPage.tsx'), 'utf8');
    // Each response option is busy only while IT is submitting — siblings stay
    // disabled but not "busy" (a busy flag on untouched controls misreports
    // their state to assistive tech).
    expect(source).toContain('aria-busy={busyId === item.id && busyResponse === option.value}');
    expect(source).not.toContain('aria-busy={busyId === item.id}');
  });
});
