import { describe, expect, it } from 'vitest';
import {
  canLaunchMynaHandoff,
  canRecordMynaPatientReport,
  canRecordVerification,
  patientReportToStatus,
  verificationToReceiptStatus,
  verificationToHandoffStatus,
} from './state.js';

describe('Myna handoff state', () => {
  it('keeps patient self-report separate from official receipt', () => {
    expect(patientReportToStatus('COMPLETED')).toBe('PATIENT_REPORTED_COMPLETE');
    expect(verificationToReceiptStatus('E_PRESCRIPTION_RECEIVED')).toBe('RECEIVED');
    expect(verificationToReceiptStatus('NO_RECORD_FOUND')).toBe('EXPECTED');
    expect(verificationToHandoffStatus('E_PRESCRIPTION_RECEIVED')).toBe('CLOSED');
    expect(verificationToHandoffStatus('PRESCRIPTION_EXPIRED')).toBe('EXPIRED');
  });

  it('allows launch only for an unexpired created handoff', () => {
    const now = '2026-08-17T10:00:00.000Z';
    expect(canLaunchMynaHandoff('CREATED', '2026-08-17T10:01:00.000Z', now)).toBe(true);
    expect(canLaunchMynaHandoff('LAUNCH_REQUESTED', '2026-08-17T10:01:00.000Z', now)).toBe(true);
    expect(canLaunchMynaHandoff('CREATED', '2026-08-17T09:59:00.000Z', now)).toBe(false);
    expect(canLaunchMynaHandoff('CLOSED', '2026-08-17T10:01:00.000Z', now)).toBe(false);
  });

  it('only permits official receipt verification to unlock the receipt state', () => {
    expect(canRecordVerification('E_PRESCRIPTION_RECEIVED')).toBe(true);
    expect(canRecordVerification('CONSENT_ONLY_OR_NO_PRESCRIPTION')).toBe(true);
    expect(canRecordVerification('SUBMITTED_TO_OTHER_PHARMACY')).toBe(true);
    expect(canRecordVerification('PATIENT_MISMATCH')).toBe(true);
  });

  it('keeps terminal patient states final and only permits paper fallback after a report', () => {
    expect(canRecordMynaPatientReport('CREATED', 'COMPLETED')).toBe(true);
    expect(canRecordMynaPatientReport('PATIENT_REPORTED_COMPLETE', 'COMPLETED')).toBe(true);
    expect(canRecordMynaPatientReport('PATIENT_REPORTED_COMPLETE', 'NO_PRESCRIPTION_FOUND')).toBe(false);
    expect(canRecordMynaPatientReport('PATIENT_REPORTED_COMPLETE', 'SWITCH_TO_PAPER')).toBe(true);
    expect(canRecordMynaPatientReport('PAPER_FALLBACK', 'COMPLETED')).toBe(false);
    expect(canRecordMynaPatientReport('ABANDONED', 'SWITCH_TO_PAPER')).toBe(false);
  });
});
