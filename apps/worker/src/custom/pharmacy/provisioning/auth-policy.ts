export type AdminSessionKind = 'bootstrap' | 'standard';

const POLICIES = {
  bootstrap: { absoluteMs: 30 * 60_000, idleMs: 10 * 60_000 },
  standard: { absoluteMs: 8 * 60 * 60_000, idleMs: 15 * 60_000 },
} as const;

export function sessionPolicy(kind: AdminSessionKind): {
  absoluteMs: number;
  idleMs: number;
} {
  return POLICIES[kind];
}

export function sessionMaxAgeSeconds(kind: AdminSessionKind): number {
  return sessionPolicy(kind).absoluteMs / 1000;
}

export function sessionExpiresAt(kind: AdminSessionKind, now: Date): string {
  return new Date(now.getTime() + sessionPolicy(kind).absoluteMs).toISOString();
}

export function sessionIdleCutoff(kind: AdminSessionKind, now: Date): string {
  return new Date(now.getTime() - sessionPolicy(kind).idleMs).toISOString();
}
