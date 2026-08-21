import { describe, expect, it, vi } from 'vitest';
import {
  buildPharmacyConfigurationDoctor,
  getPharmacyConfigurationDoctor,
  PHARMACY_CONFIGURATION_REASON_CODES,
} from './configuration-doctor.js';

const readCredential = vi.hoisted(() => vi.fn());
vi.mock('./provisioning/line-credential-store.js', () => ({ readLineCredential: readCredential }));

const disabledReadiness = {
  accountId: 'account-a',
  checkedAt: '2026-08-21T00:00:00.000Z',
  electronicPrescription: {
    status: 'BLOCKED' as const, capabilityEnabled: false,
    reasonCodes: ['ELECTRONIC_CAPABILITY_DISABLED'] as const,
  },
  emergencyContraception: {
    status: 'BLOCKED' as const, capabilityEnabled: false,
    reasonCodes: ['EMERGENCY_CAPABILITY_DISABLED'] as const,
  },
  richMenu: {
    status: 'BLOCKED' as const, capabilityEnabled: false,
    reasonCodes: ['RICH_MENU_CAPABILITY_DISABLED'] as const,
  },
};

const readyInput = {
  accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
  tenantMapped: true, tenantActive: true, accountActive: true,
  staffAssigned: true, capabilityConfigured: true, botIdentityConfigured: true,
  liffIdConfigured: true, liffOriginValid: true, liffEndpointStatus: 'READY' as const,
  loginChannelConfigured: true, messagingCredentialsConfigured: true,
  loginCredentialConfigured: true, credentialStatus: 'READY' as const,
  readiness: disabledReadiness,
};

describe('pharmacy configuration doctor', () => {
  it('returns READY when required checks pass and disabled features remain optional', () => {
    const result = buildPharmacyConfigurationDoctor(readyInput);
    expect(result.status).toBe('READY');
    expect(result.reasonCodes).toEqual([]);
    expect(result.checks.filter((check) => !check.required).map((check) => check.key))
      .toEqual(['electronicPrescription', 'emergencyContraception', 'richMenu']);
  });

  it('returns fixed BLOCKED reasons with safe repair links', () => {
    const result = buildPharmacyConfigurationDoctor({
      ...readyInput,
      staffAssigned: false,
      liffIdConfigured: false,
      messagingCredentialsConfigured: false,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toEqual([
      'STAFF_ASSIGNMENT_MISSING', 'LIFF_ID_MISSING', 'MESSAGING_CREDENTIAL_MISSING',
    ]);
    expect(result.checks.filter((check) => check.status === 'BLOCKED')).toEqual([
      expect.objectContaining({ key: 'staffAssignment', fixHref: '/staff' }),
      expect.objectContaining({ key: 'liffEndpoint', fixHref: '/accounts' }),
      expect.objectContaining({ key: 'lineCredentials', fixHref: '/accounts' }),
    ]);
  });

  it('keeps failed readiness and credential checks UNVERIFIED instead of calling them missing', () => {
    const result = buildPharmacyConfigurationDoctor({
      ...readyInput, readiness: null, credentialStatus: 'UNVERIFIED',
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reasonCodes).toEqual(['LINE_CREDENTIAL_UNVERIFIED', 'READINESS_UNAVAILABLE']);
    expect(result.reasonCodes).not.toContain('MESSAGING_CREDENTIAL_MISSING');
  });

  it('emits only allowlisted reason codes and no PHI or credential fields', () => {
    const serialized = JSON.stringify(buildPharmacyConfigurationDoctor({
      ...readyInput, liffEndpointStatus: 'UNVERIFIED',
    }));
    const result = JSON.parse(serialized) as { reasonCodes: string[] };
    expect(result.reasonCodes.every((code) =>
      (PHARMACY_CONFIGURATION_REASON_CODES as readonly string[]).includes(code))).toBe(true);
    expect(serialized).not.toMatch(/patientId|friendId|token|secret|credentialValue|prescriptionPayload/iu);
  });

  it('builds the same safe doctor projection from a tenant-scoped account snapshot', async () => {
    readCredential.mockResolvedValue('decrypted-value');
    const first = vi.fn().mockResolvedValue({
      tenant_id: 'tenant-a', tenant_status: 'active', is_active: 1,
      liff_id: 'liff-a', login_channel_id: 'login-a',
      active_staff_assignment_count: 1, capability_config_count: 1,
      bot_identity_count: 1, messaging_credential_count: 2, login_credential_count: 1,
    });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
    } as unknown as D1Database;

    const result = await getPharmacyConfigurationDoctor({
      db, tenantId: 'tenant-a', accountId: 'account-a',
      liffPublicUrl: 'https://liff.example.test', credentialKey: 'root-key',
      readiness: disabledReadiness,
    });

    expect(result).toMatchObject({
      accountId: 'account-a', status: 'UNVERIFIED',
      reasonCodes: ['LIFF_ENDPOINT_UNVERIFIED'],
    });
    expect(readCredential).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('decrypted-value');
  });
});
