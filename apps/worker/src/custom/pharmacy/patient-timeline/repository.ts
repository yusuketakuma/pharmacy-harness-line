import type { PrescriptionPatient } from '../prescriptions/patient.js';

export type TimelineDomain =
  | 'prescription'
  | 'electronic_prescription'
  | 'continuity'
  | 'medication_follow_up';
export type TimelineStatus =
  | 'pending'
  | 'action_required'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'unknown';
export type TimelineNextAction = 'open_detail' | 'wait' | 'review_required' | 'none';

export type PatientTimelineItem = {
  domain: TimelineDomain;
  status: TimelineStatus;
  nextAction: TimelineNextAction;
  occurredAt: string;
  detailPath: string;
};

type TimelineState = readonly [TimelineStatus, TimelineNextAction];
type TimelineRow = {
  domain: TimelineDomain;
  source_status: string;
  occurred_at: string;
  detail_path: string;
};

const UNKNOWN_STATE: TimelineState = ['unknown', 'open_detail'];
const TIMELINE_STATES: Record<TimelineDomain, Record<string, TimelineState>> = {
  prescription: {
    draft: ['pending', 'open_detail'],
    received: ['pending', 'wait'],
    needs_resubmission: ['action_required', 'review_required'],
    accepted: ['in_progress', 'open_detail'],
    ready: ['action_required', 'open_detail'],
    closed: ['completed', 'none'],
    cancelled: ['cancelled', 'none'],
  },
  electronic_prescription: {
    CREATED: ['pending', 'open_detail'],
    LAUNCH_REQUESTED: ['pending', 'open_detail'],
    PATIENT_REPORTED_COMPLETE: ['in_progress', 'wait'],
    PATIENT_REPORTED_NO_PRESCRIPTION: ['action_required', 'open_detail'],
    SUPPORT_NEEDED: ['action_required', 'open_detail'],
    PAPER_FALLBACK: ['cancelled', 'open_detail'],
    ABANDONED: ['cancelled', 'none'],
    EXPIRED: ['cancelled', 'open_detail'],
    CLOSED: ['completed', 'none'],
  },
  continuity: {
    active: ['in_progress', 'open_detail'],
    linked: ['in_progress', 'wait'],
    fulfilled: ['completed', 'none'],
    paused: ['action_required', 'open_detail'],
    ended: ['completed', 'none'],
  },
  medication_follow_up: {
    scheduled: ['pending', 'wait'],
    due: ['action_required', 'open_detail'],
    delivered: ['action_required', 'open_detail'],
    no_issue: ['completed', 'none'],
    concern: ['action_required', 'open_detail'],
    pharmacist_requested: ['action_required', 'open_detail'],
    assigned: ['in_progress', 'wait'],
    responded: ['completed', 'none'],
    escalated: ['in_progress', 'wait'],
    closed: ['completed', 'none'],
    cancelled: ['cancelled', 'none'],
  },
};

/** Read-only, deliberately lossy projection over existing domain roots. */
export async function listPatientTimeline(
  db: D1Database,
  patient: PrescriptionPatient,
): Promise<PatientTimelineItem[]> {
  const result = await db.prepare(
    `WITH scope AS (
       SELECT ? AS line_account_id, ? AS friend_id
     ), timeline AS (
       SELECT 'prescription' AS domain, s.status AS source_status,
              COALESCE((
                SELECT MAX(e.created_at)
                  FROM pharmacy_prescription_events e
                 WHERE e.submission_id = s.id
                   AND e.event_type = 'status_changed'
                   AND e.to_status = s.status
              ), s.created_at) AS occurred_at, s.id AS record_id,
              '/prescriptions?view=history' AS detail_path
         FROM pharmacy_prescription_submissions s
         CROSS JOIN scope
        WHERE s.line_account_id = scope.line_account_id
          AND s.friend_id = scope.friend_id
       UNION ALL
       SELECT 'electronic_prescription', h.status, h.created_at, h.id,
              '/prescriptions?view=electronic'
         FROM pharmacy_myna_handoffs h
         CROSS JOIN scope
        WHERE h.line_account_id = scope.line_account_id
          AND h.friend_id = scope.friend_id
          AND h.method = 'E_PRESCRIPTION'
       UNION ALL
       SELECT 'continuity', o.status, o.created_at, o.id,
              '/pharmacy/continuity'
         FROM pharmacy_continuity_obligations o
         CROSS JOIN scope
        WHERE o.line_account_id = scope.line_account_id
          AND o.owner_friend_id = scope.friend_id
       UNION ALL
       SELECT 'medication_follow_up', f.status, f.created_at, f.id,
              '/pharmacy/medication-followup'
         FROM pharmacy_medication_followups f
         CROSS JOIN scope
        WHERE f.line_account_id = scope.line_account_id
          AND f.owner_friend_id = scope.friend_id
     )
     SELECT domain, source_status, occurred_at, detail_path
       FROM timeline
      ORDER BY occurred_at DESC, domain ASC, record_id ASC
      LIMIT 50`,
  ).bind(patient.lineAccountId, patient.friendId).all<TimelineRow>();

  // ponytail: EC existence is sensitive; add it only after a human-approved neutral destination exists.
  return result.results.map((row) => {
    const [status, nextAction] = TIMELINE_STATES[row.domain][row.source_status] ?? UNKNOWN_STATE;
    return {
      domain: row.domain,
      status,
      nextAction,
      occurredAt: row.occurred_at,
      detailPath: row.detail_path,
    };
  });
}
