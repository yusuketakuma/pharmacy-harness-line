export type MynaMethod =
  | 'E_PRESCRIPTION'
  | 'PAPER'
  | 'MEDICAL_INSTITUTION_SENT';

export type MynaHandoffStatus =
  | 'CREATED'
  | 'LAUNCH_REQUESTED'
  | 'PATIENT_REPORTED_COMPLETE'
  | 'PATIENT_REPORTED_NO_PRESCRIPTION'
  | 'SUPPORT_NEEDED'
  | 'PAPER_FALLBACK'
  | 'ABANDONED'
  | 'EXPIRED'
  | 'CLOSED';

export type MynaPatientReport =
  | 'COMPLETED'
  | 'NO_PRESCRIPTION_FOUND'
  | 'FAILED'
  | 'SWITCH_TO_PAPER';

export type MynaVerificationStatus =
  | 'NOT_CHECKED'
  | 'E_PRESCRIPTION_RECEIVED'
  | 'CONSENT_ONLY_OR_NO_PRESCRIPTION'
  | 'NO_RECORD_FOUND'
  | 'SUBMITTED_TO_OTHER_PHARMACY'
  | 'PRESCRIPTION_EXPIRED'
  | 'PAPER_FALLBACK'
  | 'PATIENT_MISMATCH'
  | 'MANUAL_EXCEPTION';

export type PrescriptionReceiptStatus =
  | 'EXPECTED'
  | 'RECEIPT_REPORTED'
  | 'RECEIVED'
  | 'FULFILLMENT_REVIEW'
  | 'ACCEPTED'
  | 'DISPENSING'
  | 'READY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'EXPIRED';

const PATIENT_REPORT_STATUS: Record<MynaPatientReport, MynaHandoffStatus> = {
  COMPLETED: 'PATIENT_REPORTED_COMPLETE',
  NO_PRESCRIPTION_FOUND: 'PATIENT_REPORTED_NO_PRESCRIPTION',
  FAILED: 'SUPPORT_NEEDED',
  SWITCH_TO_PAPER: 'PAPER_FALLBACK',
};

const VERIFICATION_STATUSES = new Set<MynaVerificationStatus>([
  'E_PRESCRIPTION_RECEIVED',
  'CONSENT_ONLY_OR_NO_PRESCRIPTION',
  'NO_RECORD_FOUND',
  'SUBMITTED_TO_OTHER_PHARMACY',
  'PRESCRIPTION_EXPIRED',
  'PAPER_FALLBACK',
  'PATIENT_MISMATCH',
  'MANUAL_EXCEPTION',
]);

export function patientReportToStatus(result: MynaPatientReport): MynaHandoffStatus {
  return PATIENT_REPORT_STATUS[result];
}

export function canLaunchMynaHandoff(
  status: MynaHandoffStatus,
  expiresAt: string,
  now = new Date().toISOString(),
): boolean {
  if (status !== 'CREATED' && status !== 'LAUNCH_REQUESTED') return false;
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(now);
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry > current;
}

export function canRecordVerification(status: MynaVerificationStatus): boolean {
  return VERIFICATION_STATUSES.has(status);
}

export function verificationToReceiptStatus(
  status: MynaVerificationStatus,
): PrescriptionReceiptStatus {
  return status === 'E_PRESCRIPTION_RECEIVED' ? 'RECEIVED' : 'EXPECTED';
}

export function verificationToHandoffStatus(
  status: MynaVerificationStatus,
): MynaHandoffStatus {
  if (status === 'E_PRESCRIPTION_RECEIVED') return 'CLOSED';
  if (status === 'PRESCRIPTION_EXPIRED') return 'EXPIRED';
  if (status === 'PAPER_FALLBACK') return 'PAPER_FALLBACK';
  return 'SUPPORT_NEEDED';
}
