import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { createLineRetryKey } from '../../../services/broadcast-retry-key.js';
import {
  LineHarnessUnknownOutcomeError,
  pushViaHarnessProxy,
} from '../../../services/line-proxy-send.js';
import { getPharmacyCapabilityConfig } from './repository.js';
import { getPatientAccessState } from '../intake/repository.js';
import {
  getPharmacyBetaEnabled,
  getPharmacyBetaSchemaState,
  getPharmacyBetaMembershipDeliveryState,
} from '../beta-membership/repository.js';
import {
  buildApprovedPharmacyMessage,
  type PharmacyAutomatedMessageId,
  type PharmacyMessageVars,
  type PharmacyNotificationCategory,
} from './policy.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LINE_RETRY_KEY_HORIZON_MS = 24 * 60 * 60 * 1000;

type AutomatedPushInput = {
  db: D1Database;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  accessToken: string;
  to: string;
  lineAccountId: string;
  friendId: string;
  patientId?: string;
  betaMembershipId?: string | null;
  messageId: PharmacyAutomatedMessageId;
  category: Exclude<PharmacyNotificationCategory, 'manual'>;
  vars?: PharmacyMessageVars;
  retryKey: string;
  now?: Date;
};

export type PharmacyPushResult =
  | 'sent'
  | 'already_sent'
  | 'in_progress'
  | 'reconciliation_required'
  | 'patient_blocked'
  | 'operations_blocked'
  | 'paused';

function jstMonthBounds(now: Date): { from: string; to: string } {
  const local = new Date(now.getTime() + JST_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1) - JST_OFFSET_MS).toISOString(),
  };
}

async function markOutcome(
  db: D1Database,
  lineAccountId: string,
  retryKey: string,
  outcome: 'sent' | 'failed' | 'blocked',
  occurredAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE pharmacy_notification_events
        SET outcome = ?, occurred_at = ?
      WHERE line_account_id = ? AND idempotency_key = ? AND outcome <> 'sent'`,
  ).bind(outcome, occurredAt, lineAccountId, retryKey).run();
}

async function recordBlocked(input: AutomatedPushInput, occurredAt: string): Promise<void> {
  await input.db.prepare(
    `INSERT OR IGNORE INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome,
       schema_version, occurred_at, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'blocked', 1, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.lineAccountId, input.friendId, input.messageId,
    input.category, occurredAt, input.retryKey, occurredAt,
  ).run();
  await input.db.prepare(
    `UPDATE pharmacy_notification_events
        SET outcome = 'blocked', occurred_at = ?
      WHERE line_account_id = ? AND idempotency_key = ?
        AND outcome IN ('attempted','failed')`,
  ).bind(occurredAt, input.lineAccountId, input.retryKey).run();
}

type PatientDeliveryState = 'allowed' | 'retryable' | 'blocked';

async function getPatientDeliveryState(
  input: AutomatedPushInput,
  now = new Date(),
): Promise<PatientDeliveryState> {
  if (!input.patientId) return 'allowed';
  const access = await getPatientAccessState(input.db, {
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
  }, input.patientId);
  if (access?.privacy !== 'active' || access.notifications !== 'enabled') return 'blocked';
  const betaEnabled = await getPharmacyBetaEnabled(input.db, input.lineAccountId);
  if (betaEnabled === null) return 'blocked';
  if (!betaEnabled) return 'allowed';
  if (!input.betaMembershipId) return 'blocked';
  const membership = await getPharmacyBetaMembershipDeliveryState(input.db, {
    lineAccountId: input.lineAccountId,
    participantFriendId: input.friendId,
    subjectPatientId: input.patientId,
    membershipId: input.betaMembershipId,
    now,
  });
  return membership === 'active' ? 'allowed' : membership === 'suspended' ? 'retryable' : 'blocked';
}

type FinalDispatchState = 'ok' | 'paused' | 'blocked' | 'patient_retryable' | 'operations_blocked';

async function medicationFollowUpOperationsReady(
  db: D1Database,
  lineAccountId: string,
): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT operations.enabled
         FROM pharmacy_medication_followup_operations AS operations
        WHERE operations.line_account_id = ? AND operations.enabled = 1
          AND ${activeHumanFollowUpStaffPredicate('operations.line_account_id', 'operations.primary_staff_id')}
          AND (
            operations.backup_staff_id IS NULL
            OR ${activeHumanFollowUpStaffPredicate('operations.line_account_id', 'operations.backup_staff_id')}
          )
        LIMIT 1`,
    ).bind(lineAccountId).first<{ enabled: number }>();
    return row?.enabled === 1;
  } catch {
    return false;
  }
}

function activeHumanFollowUpStaffPredicate(accountColumn: string, staffColumn: string): string {
  return `EXISTS (
    SELECT 1
      FROM tenant_line_accounts AS staff_mapping
      INNER JOIN line_accounts AS staff_account
              ON staff_account.id = staff_mapping.line_account_id
             AND staff_account.is_active = 1
      INNER JOIN tenants AS staff_tenant
              ON staff_tenant.id = staff_mapping.tenant_id
             AND staff_tenant.status = 'active'
      INNER JOIN tenant_staff_memberships AS staff_membership
              ON staff_membership.tenant_id = staff_mapping.tenant_id
             AND staff_membership.staff_id = ${staffColumn}
             AND staff_membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = ${staffColumn}
             AND staff.is_active = 1
             AND staff.principal_kind = 'human'
      INNER JOIN pharmacy_staff_accounts AS staff_assignment
              ON staff_assignment.line_account_id = ${accountColumn}
             AND staff_assignment.staff_id = ${staffColumn}
             AND staff_assignment.is_active = 1
     WHERE staff_mapping.line_account_id = ${accountColumn}
  )`;
}

function followUpOperationsReadyPredicate(accountColumn: string): string {
  return `EXISTS (
    SELECT 1
      FROM pharmacy_medication_followup_operations AS operations
     WHERE operations.line_account_id = ${accountColumn}
       AND operations.enabled = 1
       AND ${activeHumanFollowUpStaffPredicate(accountColumn, 'operations.primary_staff_id')}
       AND (
         operations.backup_staff_id IS NULL
         OR ${activeHumanFollowUpStaffPredicate(accountColumn, 'operations.backup_staff_id')}
       )
  )`;
}

async function getFinalDispatchState(
  input: AutomatedPushInput,
  requiredCapability: string,
): Promise<FinalDispatchState> {
  const followUpId = input.messageId === 'medication_followup_v1'
    ? input.vars?.followUpId ?? null
    : null;
  const betaSchema = input.patientId
    ? await getPharmacyBetaSchemaState(input.db)
    : 'legacy';
  if (betaSchema === 'unavailable') return 'blocked';
  const patientJoin = input.patientId
    ? `
        INNER JOIN pharmacy_patients AS patient
                ON patient.id = ?
               AND patient.line_account_id = friend.line_account_id
               AND patient.owner_friend_id = friend.id
        LEFT JOIN pharmacy_patient_owner_controls AS patient_controls
               ON patient_controls.line_account_id = patient.line_account_id
              AND patient_controls.patient_id = patient.id
              AND patient_controls.owner_friend_id = patient.owner_friend_id
        LEFT JOIN pharmacy_patient_proxy_grants AS patient_proxy
               ON patient_proxy.line_account_id = patient.line_account_id
              AND patient_proxy.patient_id = patient.id
              AND patient_proxy.actor_friend_id = friend.id
              AND patient_proxy.permission_code = 'patient_intake_v1'
              AND patient_proxy.revoked_at IS NULL
              AND patient_proxy.superseded_at IS NULL
              AND unixepoch(patient_proxy.expires_at) > unixepoch(?)`
    : '';
  const patientScope = input.patientId
    ? `
       AND patient.archived_at IS NULL
       AND patient_controls.binding_suspended_at IS NULL
       AND (
         patient.relationship = 'self'
         OR (
           patient.relationship = 'child'
           AND date(patient.birth_date, '+18 years') > date('now', '+9 hours')
           AND patient_proxy.id IS NOT NULL
         )
       )
       AND (
         patient_controls.privacy_withdrawn_at IS NULL
         OR (
           patient_controls.privacy_reconsented_at IS NOT NULL
           AND unixepoch(patient_controls.privacy_withdrawn_at) <=
               unixepoch(patient_controls.privacy_reconsented_at)
         )
       )
       AND (
         patient_controls.notifications_stopped_at IS NULL
         OR (
           patient_controls.notifications_resumed_at IS NOT NULL
           AND unixepoch(patient_controls.notifications_stopped_at) <=
               unixepoch(patient_controls.notifications_resumed_at)
         )
       )`
    : '';
  const betaScope = input.patientId && betaSchema === 'ready'
    ? `
       AND (
         NOT EXISTS (
           SELECT 1 FROM pharmacy_account_capabilities AS beta_capability
            WHERE beta_capability.line_account_id = friend.line_account_id
              AND beta_capability.mode = 'pharmacy'
              AND beta_capability.beta_enabled = 1
         )
         OR EXISTS (
           SELECT 1 FROM pharmacy_beta_memberships AS beta_membership
            WHERE beta_membership.line_account_id = friend.line_account_id
              AND beta_membership.id = ?
              AND beta_membership.participant_friend_id = friend.id
              AND beta_membership.subject_patient_id = patient.id
              AND beta_membership.status IN ('active', 'suspended')
              AND unixepoch(beta_membership.starts_at) <= unixepoch('now')
              AND unixepoch(beta_membership.expires_at) > unixepoch('now')
         )
       )`
    : '';
  const betaMembershipStatus = input.patientId && betaSchema === 'ready'
    ? `(
         SELECT beta_membership.status
           FROM pharmacy_beta_memberships AS beta_membership
          WHERE beta_membership.line_account_id = friend.line_account_id
            AND beta_membership.id = ?
            AND beta_membership.participant_friend_id = friend.id
            AND beta_membership.subject_patient_id = patient.id
            AND EXISTS (
              SELECT 1 FROM pharmacy_account_capabilities AS beta_capability
               WHERE beta_capability.line_account_id = friend.line_account_id
                 AND beta_capability.mode = 'pharmacy'
                 AND beta_capability.beta_enabled = 1
            )
          ORDER BY CASE beta_membership.status
                     WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
                   beta_membership.updated_at DESC, beta_membership.id DESC
          LIMIT 1
       ) AS beta_membership_status`
    : 'NULL AS beta_membership_status';
  const operationsSelect = followUpId === null
    ? '1 AS followup_operations_enabled'
    : `CASE WHEN ${followUpOperationsReadyPredicate('friend.line_account_id')}
            THEN 1 ELSE 0 END AS followup_operations_enabled`;
  const row = await input.db.prepare(
    `/* final pharmacy dispatch scope */
      SELECT friend.provider_line_user_id AS destination_line_user_id,
             friend.is_following,
             account.is_active AS account_active,
             tenant.status AS tenant_status,
             tenant.outbound_messaging_paused_at,
             CASE WHEN capability.mode = 'pharmacy' AND EXISTS (
               SELECT 1 FROM json_each(capability.capabilities_json)
                WHERE json_each.value = ?
             ) THEN 1 ELSE 0 END AS capability_enabled,
             followup.status AS followup_status,
             ${operationsSelect},
             ${betaMembershipStatus}
        FROM friends AS friend
        INNER JOIN line_accounts AS account
                ON account.id = friend.line_account_id
        INNER JOIN tenant_line_accounts AS mapping
                ON mapping.line_account_id = friend.line_account_id
        INNER JOIN tenants AS tenant
                ON tenant.id = mapping.tenant_id
        INNER JOIN pharmacy_account_capabilities AS capability
                ON capability.line_account_id = friend.line_account_id
        ${patientJoin}
        LEFT JOIN pharmacy_medication_followups AS followup
               ON followup.id = ?
              AND followup.line_account_id = friend.line_account_id
              AND followup.owner_friend_id = friend.id
              AND followup.patient_id = ?
       WHERE friend.id = ? AND friend.line_account_id = ?
         ${patientScope}
         ${betaScope}
       LIMIT 1`,
  ).bind(
    requiredCapability,
    ...(input.patientId && betaSchema === 'ready' ? [input.betaMembershipId ?? ''] : []),
    ...(input.patientId ? [input.patientId, new Date().toISOString()] : []),
    followUpId,
    input.patientId ?? null,
    input.friendId,
    input.lineAccountId,
    ...(input.patientId && betaSchema === 'ready' ? [input.betaMembershipId ?? ''] : []),
  ).first<{
    destination_line_user_id: string | null;
    is_following: number;
    account_active: number;
    tenant_status: string;
    outbound_messaging_paused_at: string | null;
    capability_enabled: number;
    followup_status: string | null;
    followup_operations_enabled: number | null;
    beta_membership_status: 'active' | 'suspended' | 'revoked' | null;
  }>();

  if (!row || row.destination_line_user_id !== input.to || row.is_following !== 1 ||
      row.account_active !== 1 || row.tenant_status !== 'active' ||
      row.capability_enabled !== 1) {
    return 'blocked';
  }
  if (row.beta_membership_status === 'suspended') return 'patient_retryable';
  if (followUpId !== null &&
      row.followup_status !== 'due') {
    return 'blocked';
  }
  if (followUpId !== null && row.followup_operations_enabled !== 1) {
    return 'operations_blocked';
  }
  return row.outbound_messaging_paused_at ? 'paused' : 'ok';
}

export async function sendPharmacyAutomatedPush(
  input: AutomatedPushInput,
): Promise<PharmacyPushResult> {
  if (!input.db || !input.lineAccountId || !input.friendId) {
    throw new Error('pharmacy notification account context is required');
  }

  const message = buildApprovedPharmacyMessage(input.messageId, input.vars);
  const accountConfig = await getPharmacyCapabilityConfig(input.db, input.lineAccountId);
  const requiredCapability = input.messageId === 'continuity_reminder_v1'
    ? 'continuity'
    : input.messageId === 'medication_followup_v1'
      ? 'medication_followup'
      : input.messageId === 'myna_handoff_status_v1'
        ? 'electronic_prescription'
      : input.messageId === 'emergency_intake_status_v1'
        ? 'emergency_contraception'
      : input.messageId === 'appointment_reminder_v1'
        ? 'emergency_contraception'
      : input.messageId === 'meet_consultation_v1'
        ? 'meet_consultation'
      : 'prescription_intake';
  if (!accountConfig || !accountConfig.capabilities.includes(requiredCapability)) {
    throw new Error('pharmacy notification capability is not enabled');
  }

  // Outbound pause is checked here, the one choke point every pharmacy
  // proactive push routes through, and BEFORE the idempotency claim below:
  // a paused send must not burn the retry key or the proactive monthly cap,
  // so the same message can still go out once the tenant is unpaused.
  // Inbound webhook processing is deliberately unaffected — a paused tenant
  // still receives and stores everything.
  const pausedRow = await input.db.prepare(
    `SELECT tenant.outbound_messaging_paused_at
       FROM tenant_line_accounts AS mapping
       INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
      WHERE mapping.line_account_id = ?
      LIMIT 1`,
  ).bind(input.lineAccountId).first<{ outbound_messaging_paused_at: string | null }>();
  if (pausedRow?.outbound_messaging_paused_at) {
    console.log(
      `[pharmacy-notification] skipped, not sent — outbound messaging paused since ${pausedRow.outbound_messaging_paused_at} ` +
      `(line_account=${input.lineAccountId} message=${input.messageId})`,
    );
    return 'paused';
  }
  if (input.messageId === 'medication_followup_v1' &&
      !(await medicationFollowUpOperationsReady(input.db, input.lineAccountId))) {
    return 'operations_blocked';
  }

  const now = input.now ?? new Date();
  const occurredAt = now.toISOString();
  const staleAttemptAt = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const retryHorizonStart = new Date(now.getTime() - LINE_RETRY_KEY_HORIZON_MS).toISOString();
  const month = jstMonthBounds(now);
  const notificationEventId = crypto.randomUUID();
  let dispatchEventId = notificationEventId;
  const initialPatientState = await getPatientDeliveryState(input, now);
  if (initialPatientState !== 'allowed') {
    if (initialPatientState === 'blocked') await recordBlocked(input, occurredAt);
    return 'patient_blocked';
  }
  const claim = await input.db.prepare(
    `INSERT OR IGNORE INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome,
       schema_version, occurred_at, idempotency_key, created_at)
     SELECT ?, ?, ?, ?, ?, 'attempted', 1, ?, ?, ?
      WHERE ? <> 'proactive_noncare' OR (
        SELECT COUNT(*) FROM pharmacy_notification_events
         WHERE line_account_id = ? AND friend_id = ?
           AND category = 'proactive_noncare'
           AND outcome IN ('attempted','sent')
           AND occurred_at >= ? AND occurred_at < ?
      ) < ?`,
  ).bind(
    notificationEventId, input.lineAccountId, input.friendId, input.messageId,
    input.category, occurredAt, input.retryKey, occurredAt,
    input.category, input.lineAccountId, input.friendId, month.from, month.to,
    accountConfig.proactive_monthly_limit,
  ).run();

  if ((claim.meta?.changes ?? 0) !== 1) {
    const existing = await input.db.prepare(
      `SELECT id, outcome, occurred_at, created_at FROM pharmacy_notification_events
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(input.lineAccountId, input.retryKey).first<{
      id: string; outcome: string; occurred_at: string; created_at?: string;
    }>();
    if (existing?.outcome === 'sent') return 'already_sent';
    if (existing?.outcome === 'blocked') {
      throw new Error('pharmacy proactive frequency cap reached');
    }
    if (existing?.outcome === 'attempted') {
      if ((existing.created_at ?? existing.occurred_at) <= retryHorizonStart) {
        return 'reconciliation_required';
      }
      if (existing.occurred_at >= staleAttemptAt) return 'in_progress';
      const reclaimed = await input.db.prepare(
        `UPDATE pharmacy_notification_events
            SET occurred_at = ?
          WHERE line_account_id = ? AND idempotency_key = ?
            AND outcome = 'attempted' AND occurred_at < ?`,
      ).bind(occurredAt, input.lineAccountId, input.retryKey, staleAttemptAt).run();
      if ((reclaimed.meta?.changes ?? 0) !== 1) return 'in_progress';
      dispatchEventId = existing.id;
    } else if (existing?.outcome === 'failed') {
      const reclaimed = await input.db.prepare(
        `UPDATE pharmacy_notification_events
            SET outcome = 'attempted', occurred_at = ?
          WHERE line_account_id = ? AND idempotency_key = ? AND outcome = 'failed'
            AND (? <> 'proactive_noncare' OR (
              SELECT COUNT(*) FROM pharmacy_notification_events
               WHERE line_account_id = ? AND friend_id = ?
                 AND category = 'proactive_noncare'
                 AND outcome IN ('attempted','sent')
                 AND occurred_at >= ? AND occurred_at < ?
            ) < ?)`,
      ).bind(
        occurredAt, input.lineAccountId, input.retryKey, input.category,
        input.lineAccountId, input.friendId, month.from, month.to,
        accountConfig.proactive_monthly_limit,
      ).run();
      if ((reclaimed.meta?.changes ?? 0) !== 1) {
        await input.db.prepare(
          `UPDATE pharmacy_notification_events SET outcome = 'blocked', occurred_at = ?
            WHERE line_account_id = ? AND idempotency_key = ? AND outcome = 'failed'`,
        ).bind(occurredAt, input.lineAccountId, input.retryKey).run();
        throw new Error('pharmacy proactive frequency cap reached');
      }
      dispatchEventId = existing.id;
    } else {
      await recordBlocked(input, occurredAt);
      throw new Error('pharmacy proactive frequency cap reached');
    }
  }

  const postClaimPatientState = await getPatientDeliveryState(input, now);
  if (postClaimPatientState !== 'allowed') {
    if (postClaimPatientState === 'blocked') {
      await markOutcome(input.db, input.lineAccountId, input.retryKey, 'blocked', new Date().toISOString());
    }
    // No provider call has happened. Preserve an attempted row so a
    // suspended membership or a transient gate can be retried safely.
    return 'patient_blocked';
  }

  const finalNow = new Date();
  const finalPatientState = await getPatientDeliveryState(input, finalNow);
  if (finalPatientState !== 'allowed') {
    if (finalPatientState === 'blocked') {
      await markOutcome(input.db, input.lineAccountId, input.retryKey, 'blocked', finalNow.toISOString());
    }
    // The external proxy has not been called yet; do not erase result-unknown
    // semantics by converting the attempt to failed.
    return 'patient_blocked';
  }
  const finalDispatchState = await getFinalDispatchState(input, requiredCapability);
  if (finalDispatchState === 'paused') {
    return 'paused';
  }
  if (finalDispatchState === 'blocked') {
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'blocked', finalNow.toISOString());
    return 'patient_blocked';
  }
  if (finalDispatchState === 'patient_retryable') {
    return 'patient_blocked';
  }
  if (finalDispatchState === 'operations_blocked') {
    return 'operations_blocked';
  }

  try {
    await pushViaHarnessProxy(
      input.proxyBaseUrl,
      input.accessToken,
      input.to,
      [message],
      await createLineRetryKey(input.retryKey),
      input.proxyDispatch,
      {
        pharmacyNotificationEventId: dispatchEventId,
        lineAccountId: input.lineAccountId,
      },
    );
  } catch (error) {
    if (error instanceof LineHarnessUnknownOutcomeError) throw error;
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'failed', new Date().toISOString());
    throw error;
  }

  // LINE accepted the stable retry key. If this D1 finalization fails, leave
  // the row attempted so the stale retry reconciles with that same key.
  await markOutcome(input.db, input.lineAccountId, input.retryKey, 'sent', new Date().toISOString());
  return 'sent';
}
