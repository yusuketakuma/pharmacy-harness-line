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
});
