export type PrescriptionPrintTaskStatus = 'pending' | 'handling' | 'acknowledged' | 'cancelled';

export interface PrescriptionPrintTask {
  id: string;
  line_account_id: string;
  submission_id: string;
  revision: number;
  status: PrescriptionPrintTaskStatus;
  lease_until: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

type PrintTaskRow = PrescriptionPrintTask & {
  handling_by: string | null;
  handling_token: string | null;
};

const LEASE_MS = 10 * 60_000;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const SELECT = `
  SELECT t.id, t.line_account_id, t.submission_id, t.revision, t.status,
         t.handling_by, t.handling_token, t.lease_until, t.acknowledged_at,
         t.created_at, t.updated_at
    FROM pharmacy_print_tasks t`;

function changed(result: { meta?: { changes?: number } }): boolean {
  return (result.meta?.changes ?? 0) === 1;
}

function publicTask(row: PrintTaskRow | null): PrescriptionPrintTask | null {
  if (!row) return null;
  const { handling_by: _handlingBy, handling_token: _handlingToken, ...task } = row;
  return task;
}

function validOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new Error('invalid print operation id');
}

async function currentTaskRow(
  db: D1Database,
  lineAccountId: string,
  taskId: string,
): Promise<PrintTaskRow | null> {
  return db.prepare(
    `${SELECT}
     INNER JOIN pharmacy_prescription_submissions s
       ON s.id = t.submission_id AND s.line_account_id = t.line_account_id
      AND s.active_revision = t.revision
     WHERE t.id = ? AND t.line_account_id = ?`,
  ).bind(taskId, lineAccountId).first<PrintTaskRow>();
}

export async function preparePrescriptionPrintTask(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  at = new Date(),
): Promise<PrescriptionPrintTask | null> {
  const timestamp = at.toISOString();
  await db.batch([
    db.prepare(
      `UPDATE pharmacy_print_tasks
          SET status = 'cancelled', updated_at = ?
        WHERE line_account_id = ? AND submission_id = ?
          AND status IN ('pending', 'handling')
          AND revision != COALESCE((
            SELECT s.active_revision FROM pharmacy_prescription_submissions s
             WHERE s.id = ? AND s.line_account_id = ?
          ), -1)`,
    ).bind(timestamp, lineAccountId, submissionId, submissionId, lineAccountId),
    db.prepare(
      `UPDATE pharmacy_print_tasks
          SET status = 'pending', handling_by = NULL, handling_token = NULL,
              handling_at = NULL, lease_until = NULL, updated_at = ?
        WHERE line_account_id = ? AND submission_id = ? AND status = 'handling'
          AND lease_until <= ?
          AND revision = (
            SELECT s.active_revision FROM pharmacy_prescription_submissions s
             WHERE s.id = ? AND s.line_account_id = ?
          )`,
    ).bind(timestamp, lineAccountId, submissionId, timestamp, submissionId, lineAccountId),
    db.prepare(
      `INSERT INTO pharmacy_print_tasks
         (id, line_account_id, submission_id, revision, status, created_at, updated_at)
       SELECT ?, s.line_account_id, s.id, s.active_revision, 'pending', ?, ?
         FROM pharmacy_prescription_submissions s
        WHERE s.id = ? AND s.line_account_id = ?
          AND s.status IN ('received', 'accepted', 'ready')
          AND s.active_revision IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pharmacy_prescription_files f
             WHERE f.submission_id = s.id AND f.revision = s.active_revision AND f.state = 'ready'
          )
       ON CONFLICT (line_account_id, submission_id, revision) DO NOTHING`,
    ).bind(crypto.randomUUID(), timestamp, timestamp, submissionId, lineAccountId),
  ]);

  const row = await db.prepare(
    `${SELECT}
     INNER JOIN pharmacy_prescription_submissions s
       ON s.id = t.submission_id AND s.line_account_id = t.line_account_id
      AND s.active_revision = t.revision
     WHERE t.line_account_id = ? AND t.submission_id = ?`,
  ).bind(lineAccountId, submissionId).first<PrintTaskRow>();
  return publicTask(row);
}

export async function claimPrescriptionPrintTask(
  db: D1Database,
  lineAccountId: string,
  taskId: string,
  staffId: string,
  operationId: string,
  at = new Date(),
): Promise<PrescriptionPrintTask | null> {
  validOperationId(operationId);
  const timestamp = at.toISOString();
  const leaseUntil = new Date(at.getTime() + LEASE_MS).toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_print_tasks
        SET status = 'handling', handling_by = ?, handling_token = ?,
            handling_at = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ?
        AND revision = (
          SELECT s.active_revision FROM pharmacy_prescription_submissions s
           WHERE s.id = pharmacy_print_tasks.submission_id
             AND s.line_account_id = pharmacy_print_tasks.line_account_id
        )
        AND (status = 'pending' OR (status = 'handling' AND lease_until <= ?))`,
  ).bind(
    staffId, operationId, timestamp, leaseUntil, timestamp,
    taskId, lineAccountId, timestamp,
  ).run();
  const row = await currentTaskRow(db, lineAccountId, taskId);
  if (changed(result)) return publicTask(row);
  if (row?.status === 'handling' && row.handling_token === operationId &&
      row.lease_until && row.lease_until > timestamp) return publicTask(row);
  return null;
}

export async function acknowledgePrescriptionPrintTask(
  db: D1Database,
  lineAccountId: string,
  taskId: string,
  staffId: string,
  operationId: string,
  at = new Date(),
): Promise<PrescriptionPrintTask | null> {
  validOperationId(operationId);
  const timestamp = at.toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_print_tasks
        SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'handling'
        AND handling_token = ? AND lease_until > ?
        AND revision = (
          SELECT s.active_revision FROM pharmacy_prescription_submissions s
           WHERE s.id = pharmacy_print_tasks.submission_id
             AND s.line_account_id = pharmacy_print_tasks.line_account_id
        )`,
  ).bind(staffId, timestamp, timestamp, taskId, lineAccountId, operationId, timestamp).run();
  const row = await currentTaskRow(db, lineAccountId, taskId);
  if (changed(result)) return publicTask(row);
  if (row?.status === 'acknowledged' && row.handling_token === operationId) return publicTask(row);
  return null;
}
