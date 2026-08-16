import { describe, expect, it } from 'vitest';
import { nextPrescriptionStatus } from './state.js';

describe('nextPrescriptionStatus', () => {
  it.each([
    ['patient_submit', 'draft', 'received'],
    ['patient_cancel', 'draft', 'cancelled'],
    ['patient_cancel', 'received', 'cancelled'],
    ['admin_accept', 'received', 'accepted'],
    ['admin_request_resubmission', 'received', 'needs_resubmission'],
    ['admin_request_resubmission', 'accepted', 'needs_resubmission'],
    ['patient_resubmit', 'needs_resubmission', 'received'],
    ['admin_ready', 'accepted', 'ready'],
    ['admin_close', 'ready', 'closed'],
    ['admin_cancel', 'accepted', 'cancelled'],
  ] as const)('%s moves %s to %s', (action, current, expected) => {
    expect(nextPrescriptionStatus(current, action)).toBe(expected);
  });

  it.each([
    ['patient_cancel', 'accepted'],
    ['patient_resubmit', 'received'],
    ['admin_ready', 'received'],
    ['admin_close', 'accepted'],
    ['admin_accept', 'closed'],
    ['admin_cancel', 'cancelled'],
  ] as const)('rejects %s from %s', (action, current) => {
    expect(() => nextPrescriptionStatus(current, action)).toThrow(/invalid prescription transition/);
  });
});
