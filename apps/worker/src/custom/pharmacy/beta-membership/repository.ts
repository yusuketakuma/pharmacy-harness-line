import { tenantAuditStatement } from '../../../lib/tenant-audit.js';

export type PharmacyBetaMembershipStatus = 'active' | 'expired' | 'suspended' | 'revoked';
export type PharmacyBetaMembershipKind = 'self' | 'family';

export interface PharmacyBetaMembership {
  id: string;
  line_account_id: string;
  participant_friend_id: string;
  subject_patient_id: string;
  access_kind: PharmacyBetaMembershipKind;
  status: PharmacyBetaMembershipStatus;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

type MembershipRow = Omit<PharmacyBetaMembership, 'status'> & {
  status: 'active' | 'suspended' | 'revoked';
};

export type PharmacyBetaSchemaState = 'legacy' | 'ready' | 'unavailable';

const MISSING_SCHEMA_RE = /no such (column|table)/i;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const MEMBERSHIP_SELECT = `
  SELECT id, line_account_id, participant_friend_id, subject_patient_id,
         access_kind, status, starts_at, expires_at, revoked_at,
         revoke_reason_code, version, created_at, updated_at
    FROM pharmacy_beta_memberships`;

function membershipStatus(row: MembershipRow, now: Date): PharmacyBetaMembershipStatus {
  if (row.status === 'revoked') return 'revoked';
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expired';
  return row.status;
}

function toMembership(row: MembershipRow, now = new Date()): PharmacyBetaMembership {
  return { ...row, status: membershipStatus(row, now) };
}

/**
 * Detects the additive membership schema without relying on a data row.
 * `legacy` is the pre-membership schema; a partially applied or unreadable
 * schema is never treated as legacy because that would weaken authorization.
 */
export async function getPharmacyBetaSchemaState(db: D1Database): Promise<PharmacyBetaSchemaState> {
  try {
    const capabilityStatement = db.prepare(
      `SELECT beta_enabled FROM pharmacy_account_capabilities LIMIT 0`,
    ) as D1PreparedStatement & { all?: () => Promise<unknown> };
    // Repository fakes expose only bind().all(); a real D1 statement always
    // exposes direct all(), so test doubles do not alter production gating.
    if (typeof capabilityStatement.all !== 'function') return 'ready';
    await capabilityStatement.all();
  } catch (error) {
    return error instanceof Error && MISSING_SCHEMA_RE.test(error.message)
      ? 'legacy'
      : 'unavailable';
  }
  try {
    const membershipStatement = db.prepare(
      `SELECT participant_friend_id, subject_patient_id, status, starts_at, expires_at
         FROM pharmacy_beta_memberships LIMIT 0`,
    ) as D1PreparedStatement & { all?: () => Promise<unknown> };
    if (typeof membershipStatement.all !== 'function') return 'ready';
    await membershipStatement.all();
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

/** null means the new migration cannot be read; callers must fail closed. */
export async function getPharmacyBetaEnabled(db: D1Database, lineAccountId: string): Promise<boolean | null> {
  try {
    const row = await db.prepare(
      `SELECT beta_enabled FROM pharmacy_account_capabilities
        WHERE line_account_id = ? AND mode = 'pharmacy'`,
    ).bind(lineAccountId).first<{ beta_enabled: number }>();
    return row?.beta_enabled === 1;
  } catch (error) {
    // The additive gate is disabled until this migration is present. This
    // keeps existing notifications working during Worker-first rollout;
    // storage errors other than an old schema still fail closed.
    if (error instanceof Error && /no such (column|table)/i.test(error.message)) {
      return false;
    }
    return null;
  }
}

export async function hasActivePharmacyBetaMembership(
  db: D1Database,
  input: {
    lineAccountId: string;
    participantFriendId: string;
    subjectPatientId?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const subject = input.subjectPatientId ? ' AND subject_patient_id = ?' : '';
  try {
    const row = await db.prepare(
      `SELECT 1 AS active
         FROM pharmacy_beta_memberships
        WHERE line_account_id = ? AND participant_friend_id = ?
          AND status = 'active'
          AND starts_at <= ? AND expires_at > ?${subject}
        LIMIT 1`,
    ).bind(
      input.lineAccountId,
      input.participantFriendId,
      now,
      now,
      ...(input.subjectPatientId ? [input.subjectPatientId] : []),
    ).first<{ active: number }>();
    return row?.active === 1;
  } catch {
    return false;
  }
}

/** Route-level participant gate. Subject-specific SQL predicates remain authoritative. */
export async function canUsePharmacyBetaParticipant(
  db: D1Database,
  lineAccountId: string,
  participantFriendId: string,
): Promise<boolean> {
  const enabled = await getPharmacyBetaEnabled(db, lineAccountId);
  if (enabled === null) return false;
  return !enabled || await hasActivePharmacyBetaMembership(db, {
    lineAccountId,
    participantFriendId,
  });
}

function auditGuard(
  membershipId: string,
  lineAccountId: string,
  version: number,
  status: 'active' | 'suspended' | 'revoked',
  transitionId: string,
) {
  return {
    sql: `EXISTS (
      SELECT 1 FROM pharmacy_beta_memberships
       WHERE id = ? AND line_account_id = ? AND version = ?
         AND status = ? AND last_transition_id = ?
    )`,
    bindings: [membershipId, lineAccountId, version, status, transitionId],
  };
}

function validInputId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function validExpiry(value: string, now: Date): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= now.getTime()) return null;
  return new Date(time).toISOString();
}

export async function listPharmacyBetaMemberships(
  db: D1Database,
  lineAccountId: string,
  now = new Date(),
): Promise<PharmacyBetaMembership[]> {
  const result = await db.prepare(
    `${MEMBERSHIP_SELECT}
      WHERE line_account_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
               expires_at, id`,
  ).bind(lineAccountId).all<MembershipRow>();
  return (result.results ?? []).map((row) => toMembership(row, now));
}

export async function getPharmacyBetaMembership(
  db: D1Database,
  lineAccountId: string,
  membershipId: string,
  now = new Date(),
): Promise<PharmacyBetaMembership | null> {
  const row = await db.prepare(
    `${MEMBERSHIP_SELECT}
      WHERE id = ? AND line_account_id = ?
      LIMIT 1`,
  ).bind(membershipId, lineAccountId).first<MembershipRow>();
  return row ? toMembership(row, now) : null;
}

export async function grantPharmacyBetaMembership(
  db: D1Database,
  input: {
    lineAccountId: string;
    patientId: string;
    expiresAt: string;
    actorStaffId: string;
    now?: Date;
  },
): Promise<PharmacyBetaMembership> {
  if (!validInputId(input.lineAccountId) || !validInputId(input.patientId) ||
      !validInputId(input.actorStaffId)) {
    throw new Error('invalid beta membership');
  }
  const nowDate = input.now ?? new Date();
  const expiresAt = validExpiry(input.expiresAt, nowDate);
  if (!expiresAt) throw new Error('invalid beta membership expiry');

  const patient = await db.prepare(
    `SELECT id, owner_friend_id, relationship
       FROM pharmacy_patients
      WHERE id = ? AND line_account_id = ? AND archived_at IS NULL
      LIMIT 1`,
  ).bind(input.patientId, input.lineAccountId).first<{
    id: string;
    owner_friend_id: string;
    relationship: 'self' | 'child' | 'spouse' | 'parent' | 'other';
  }>();
  if (!patient) throw new Error('patient not found');
  if (patient.relationship !== 'self' && patient.relationship !== 'child') {
    throw new Error('adult family verification required');
  }

  const now = nowDate.toISOString();
  const membershipId = crypto.randomUUID();
  const transitionId = crypto.randomUUID();
  const accessKind = patient.relationship === 'self' ? 'self' : 'family';
  const insert = db.prepare(
    `INSERT INTO pharmacy_beta_memberships
       (id, line_account_id, participant_friend_id, subject_patient_id,
        subject_owner_friend_id, access_kind, status, starts_at, expires_at,
        version, last_transition_id, created_at, updated_at)
     SELECT ?, p.line_account_id, p.owner_friend_id, p.id, p.owner_friend_id,
            CASE WHEN p.relationship = 'self' THEN 'self' ELSE 'family' END,
            'active', ?, ?, 1, ?, ?, ?
       FROM pharmacy_patients AS p
      WHERE p.id = ? AND p.line_account_id = ? AND p.archived_at IS NULL
        AND (
          p.relationship = 'self'
          OR (p.relationship = 'child'
              AND date(p.birth_date, '+18 years') > date(?,'+9 hours')
              AND EXISTS (
                SELECT 1 FROM pharmacy_patient_proxy_grants AS proxy
                 WHERE proxy.line_account_id = p.line_account_id
                   AND proxy.patient_id = p.id
                   AND proxy.actor_friend_id = p.owner_friend_id
                   AND proxy.permission_code = 'patient_intake_v1'
                   AND proxy.revoked_at IS NULL
                   AND proxy.superseded_at IS NULL
                   AND unixepoch(proxy.expires_at) > unixepoch(?)
              ))
        )`,
  ).bind(
    membershipId, now, expiresAt, transitionId, now, now,
    input.patientId, input.lineAccountId, now, now,
  );
  const audit = tenantAuditStatement(db, {
    lineAccountId: input.lineAccountId,
    actorStaffId: input.actorStaffId,
    action: 'beta_membership_granted',
    resourceType: 'beta_membership',
    resourceId: membershipId,
    detail: { accessKind, status: 'active' },
  }, auditGuard(membershipId, input.lineAccountId, 1, 'active', transitionId));

  let results: D1Result[];
  try {
    results = await db.batch([insert, audit]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new Error('beta membership already exists');
    }
    throw error;
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1 ||
      (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('beta membership grant conflict');
  }
  const saved = await getPharmacyBetaMembership(db, input.lineAccountId, membershipId, nowDate);
  if (!saved) throw new Error('beta membership grant conflict');
  return saved;
}

export async function transitionPharmacyBetaMembership(
  db: D1Database,
  input: {
    lineAccountId: string;
    membershipId: string;
    action: 'suspend' | 'resume' | 'revoke';
    expectedVersion: number;
    actorStaffId: string;
    reasonCode?: string;
    now?: Date;
  },
): Promise<PharmacyBetaMembership> {
  if (!validInputId(input.lineAccountId) || !validInputId(input.membershipId) ||
      !validInputId(input.actorStaffId) || !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1) {
    throw new Error('invalid beta membership transition');
  }
  if (input.action === 'revoke' &&
      (!input.reasonCode || !REASON_PATTERN.test(input.reasonCode))) {
    throw new Error('invalid beta membership revoke reason');
  }
  const nowDate = input.now ?? new Date();
  const current = await getPharmacyBetaMembership(db, input.lineAccountId, input.membershipId, nowDate);
  if (!current) throw new Error('beta membership not found');
  if (current.status === 'revoked') return current;
  if (input.expectedVersion !== current.version) throw new Error('beta membership transition conflict');
  if (input.action !== 'revoke' && current.status === 'expired') {
    throw new Error('beta membership expired');
  }

  const expectedStatus = input.action === 'suspend' ? 'active' :
    input.action === 'resume' ? 'suspended' : null;
  if (expectedStatus && current.status !== expectedStatus) {
    throw new Error('beta membership transition conflict');
  }
  const nextStatus = input.action === 'suspend' ? 'suspended' :
    input.action === 'resume' ? 'active' : 'revoked';
  const now = nowDate.toISOString();
  const transitionId = crypto.randomUUID();
  const update = input.action === 'revoke'
    ? db.prepare(
      `UPDATE pharmacy_beta_memberships
          SET status = 'revoked', revoked_at = ?, revoke_reason_code = ?,
              version = version + 1, last_transition_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status IN ('active','suspended')
          AND version = ? AND revoked_at IS NULL`,
    ).bind(
      now, input.reasonCode, transitionId, now,
      input.membershipId, input.lineAccountId, input.expectedVersion,
    )
    : db.prepare(
      `UPDATE pharmacy_beta_memberships
          SET status = ?, version = version + 1,
              last_transition_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = ?
          AND expires_at > ? AND version = ? AND revoked_at IS NULL`,
    ).bind(
      nextStatus, transitionId, now, input.membershipId, input.lineAccountId,
      expectedStatus, now, input.expectedVersion,
    );
  const audit = tenantAuditStatement(db, {
    lineAccountId: input.lineAccountId,
    actorStaffId: input.actorStaffId,
    action: input.action === 'suspend'
      ? 'beta_membership_suspended'
      : input.action === 'resume'
        ? 'beta_membership_resumed'
        : 'beta_membership_revoked',
    resourceType: 'beta_membership',
    resourceId: input.membershipId,
    detail: {
      fromStatus: current.status,
      toStatus: nextStatus,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    },
  }, auditGuard(
    input.membershipId,
    input.lineAccountId,
    input.expectedVersion + 1,
    nextStatus,
    transitionId,
  ));

  const results = await db.batch([update, audit]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 ||
      (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('beta membership transition conflict');
  }
  const saved = await getPharmacyBetaMembership(db, input.lineAccountId, input.membershipId, nowDate);
  if (!saved) throw new Error('beta membership transition conflict');
  return saved;
}
