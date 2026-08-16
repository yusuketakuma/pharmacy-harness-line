export type PrescriptionStatus =
  | 'draft'
  | 'received'
  | 'needs_resubmission'
  | 'accepted'
  | 'ready'
  | 'closed'
  | 'cancelled';

export type PrescriptionAction =
  | 'patient_submit'
  | 'patient_cancel'
  | 'patient_resubmit'
  | 'admin_accept'
  | 'admin_request_resubmission'
  | 'admin_ready'
  | 'admin_close'
  | 'admin_cancel';

const transitions: Record<PrescriptionAction, Partial<Record<PrescriptionStatus, PrescriptionStatus>>> = {
  patient_submit: { draft: 'received' },
  patient_cancel: { draft: 'cancelled', received: 'cancelled' },
  patient_resubmit: { needs_resubmission: 'received' },
  admin_accept: { received: 'accepted' },
  admin_request_resubmission: {
    received: 'needs_resubmission',
    accepted: 'needs_resubmission',
  },
  admin_ready: { accepted: 'ready' },
  admin_close: { ready: 'closed' },
  admin_cancel: {
    draft: 'cancelled',
    received: 'cancelled',
    needs_resubmission: 'cancelled',
    accepted: 'cancelled',
    ready: 'cancelled',
  },
};

export function nextPrescriptionStatus(
  current: PrescriptionStatus,
  action: PrescriptionAction,
): PrescriptionStatus {
  const next = transitions[action][current];
  if (!next) throw new Error(`invalid prescription transition: ${action} from ${current}`);
  return next;
}
