export type PharmacyActionQueueDomain =
  | 'prescriptionIntake'
  | 'electronicPrescription'
  | 'patientIntake'
  | 'continuity'
  | 'medicationFollowup'
  | 'emergencyContraception'
  | 'manualChat';

export type PharmacyActionQueueDeadline = 'overdue' | 'today' | 'upcoming' | 'none';

export interface PharmacyActionQueueItem {
  domain: PharmacyActionQueueDomain;
  status: string;
  deadline: PharmacyActionQueueDeadline;
  detailHref: string;
}

export interface PharmacyActionQueue {
  accountId: string;
  checkedAt: string;
  partial: boolean;
  truncated: boolean;
  items: PharmacyActionQueueItem[];
}

type ActionQueueRow = {
  domain: PharmacyActionQueueDomain;
  status: string;
  id: string;
  deadline_at: string | null;
  activity_at: string | null;
};

const MAX_ITEMS = 50;
const PER_DOMAIN_LIMIT = MAX_ITEMS + 1;

const DOMAIN_QUERIES: ReadonlyArray<{
  domain: PharmacyActionQueueDomain;
  sql: string;
  // Used when an additive column is not deployed yet; keeps the domain listed.
  fallbackSql?: string;
  values: (lineAccountId: string, at: string) => Array<string | number>;
}> = [
  {
    domain: 'prescriptionIntake',
    sql: `SELECT id, status, desired_pickup_at AS deadline_at,
                 COALESCE(requested_at, created_at) AS activity_at
            FROM pharmacy_prescription_submissions
           WHERE line_account_id = ?
             AND status IN ('received', 'needs_resubmission', 'accepted', 'ready')
           ORDER BY COALESCE(desired_pickup_at, requested_at, created_at), id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'electronicPrescription',
    sql: `SELECT id, status, expires_at AS deadline_at, created_at AS activity_at
            FROM pharmacy_myna_handoffs
           WHERE line_account_id = ?
             AND status IN ('CREATED', 'LAUNCH_REQUESTED',
                           'PATIENT_REPORTED_COMPLETE', 'PATIENT_REPORTED_NO_PRESCRIPTION',
                           'SUPPORT_NEEDED', 'EXPIRED')
           ORDER BY expires_at, id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'patientIntake',
    sql: `SELECT submission_id AS id, 'unreviewed' AS status, NULL AS deadline_at,
                 created_at AS activity_at
            FROM pharmacy_prescription_patients
           WHERE line_account_id = ? AND reviewed_at IS NULL
           ORDER BY created_at, submission_id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'continuity',
    sql: `SELECT id, status, next_contact_at AS deadline_at, updated_at AS activity_at
            FROM pharmacy_continuity_obligations
           WHERE line_account_id = ? AND status = 'active'
           ORDER BY next_contact_at, id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'medicationFollowup',
    // Once staff are the blocker, the SLA deadline matters more than the
    // patient-facing due date; response_deadline_at is additive, so the
    // due_at query stays as the pre-migration fallback.
    sql: `SELECT id, status,
                 CASE WHEN status IN ('concern', 'pharmacist_requested',
                                      'assigned', 'escalated')
                           AND response_deadline_at IS NOT NULL
                      THEN response_deadline_at
                      ELSE due_at END AS deadline_at,
                 updated_at AS activity_at
            FROM pharmacy_medication_followups
           WHERE line_account_id = ?
             AND status IN ('due', 'delivered', 'concern', 'pharmacist_requested',
                           'assigned', 'responded', 'escalated')
           ORDER BY deadline_at, id
           LIMIT ?`,
    fallbackSql: `SELECT id, status, due_at AS deadline_at, updated_at AS activity_at
            FROM pharmacy_medication_followups
           WHERE line_account_id = ?
             AND status IN ('due', 'delivered', 'concern', 'pharmacist_requested',
                           'assigned', 'responded', 'escalated')
           ORDER BY due_at, id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'emergencyContraception',
    sql: `SELECT id, status, expires_at AS deadline_at, created_at AS activity_at
            FROM pharmacy_emergency_intakes
           WHERE line_account_id = ?
             AND status IN ('provisional', 'reviewed')
             AND expires_at > ?
           ORDER BY expires_at, id
           LIMIT ?`,
    values: (lineAccountId, at) => [lineAccountId, at, PER_DOMAIN_LIMIT],
  },
  {
    domain: 'manualChat',
    sql: `SELECT chat.id, chat.status, NULL AS deadline_at,
                 COALESCE(chat.last_message_at, chat.updated_at, chat.created_at) AS activity_at
            FROM chats AS chat
            INNER JOIN friends AS friend ON friend.id = chat.friend_id
           WHERE friend.line_account_id = ?
             AND (chat.line_account_id IS NULL OR chat.line_account_id = ?)
             AND chat.status IN ('unread', 'in_progress')
           ORDER BY COALESCE(chat.last_message_at, chat.updated_at, chat.created_at), chat.id
           LIMIT ?`,
    values: (lineAccountId) => [lineAccountId, lineAccountId, PER_DOMAIN_LIMIT],
  },
];

// ponytail: keep the first page fixed and link to existing scoped queues; add a
// per-domain cursor/deep-link only if the 50-item ceiling becomes operationally insufficient.
const DETAIL_HREFS: Record<PharmacyActionQueueDomain, string> = {
  prescriptionIntake: '/prescriptions',
  electronicPrescription: '/myna',
  patientIntake: '/patient-intakes',
  continuity: '/continuity',
  medicationFollowup: '/patient-intakes?followup=attention',
  emergencyContraception: '/emergency-contraception',
  manualChat: '/chats?unanswered=1',
};

const TOKYO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});

function tokyoDate(value: Date): string {
  return TOKYO_DATE_FORMATTER.format(value);
}

function deadlineKind(value: string | null, at: Date): PharmacyActionQueueDeadline {
  if (!value) return 'none';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'none';
  if (timestamp < at.getTime()) return 'overdue';
  const date = tokyoDate(new Date(timestamp));
  return date === tokyoDate(at) ? 'today' : 'upcoming';
}

function sortRank(row: ActionQueueRow, at: Date): number {
  if (!row.deadline_at || !Number.isFinite(Date.parse(row.deadline_at))) return 3;
  const timestamp = Date.parse(row.deadline_at);
  if (timestamp < at.getTime()) return 0;
  return tokyoDate(new Date(timestamp)) === tokyoDate(at) ? 1 : 2;
}

function sortTimestamp(row: ActionQueueRow, rank: number): number {
  const timestamp = Date.parse(rank === 3 ? row.activity_at ?? '' : row.deadline_at ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

export async function getPharmacyActionQueue(
  db: D1Database,
  lineAccountId: string,
  at = new Date(),
): Promise<PharmacyActionQueue> {
  const results = await Promise.allSettled(DOMAIN_QUERIES.map(async ({ domain, sql, fallbackSql, values }) => {
    const run = (statement: string) => db.prepare(statement)
      .bind(...values(lineAccountId, at.toISOString()))
      .all<{
        id: string;
        status: string;
        deadline_at: string | null;
        activity_at: string | null;
      }>();
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(sql);
    } catch (error) {
      if (!fallbackSql) throw error;
      result = await run(fallbackSql);
    }
    return (result.results ?? []).map((row) => ({ domain, ...row }));
  }));

  const rows = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  rows.sort((left, right) => {
    const leftRank = sortRank(left, at);
    const rightRank = sortRank(right, at);
    const leftTimestamp = sortTimestamp(left, leftRank);
    const rightTimestamp = sortTimestamp(right, rightRank);
    const timestampOrder = leftRank === 3
      ? rightTimestamp - leftTimestamp
      : leftTimestamp - rightTimestamp;
    return leftRank - rightRank || timestampOrder ||
    left.domain.localeCompare(right.domain) ||
    left.id.localeCompare(right.id);
  });

  return {
    accountId: lineAccountId,
    checkedAt: at.toISOString(),
    partial: results.some((result) => result.status === 'rejected'),
    truncated: rows.length > MAX_ITEMS,
    items: rows.slice(0, MAX_ITEMS).map(({ domain, status, deadline_at }) => ({
      domain,
      status,
      deadline: deadlineKind(deadline_at, at),
      detailHref: DETAIL_HREFS[domain],
    })),
  };
}
