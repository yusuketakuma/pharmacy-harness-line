import { PHARMACY_READINESS_REASON_CODES } from './readiness.js';
import { readLineCredential } from './provisioning/line-credential-store.js';

export const PHARMACY_CONFIGURATION_REASON_CODES = [
  'TENANT_MAPPING_MISSING', 'TENANT_INACTIVE', 'ACCOUNT_INACTIVE',
  'STAFF_ASSIGNMENT_MISSING', 'CAPABILITY_CONFIG_MISSING', 'BOT_IDENTITY_MISSING',
  'LIFF_ID_MISSING', 'LIFF_PUBLIC_ORIGIN_INVALID', 'LIFF_ENDPOINT_UNVERIFIED',
  'LOGIN_CHANNEL_MISSING', 'MESSAGING_CREDENTIAL_MISSING', 'LOGIN_CREDENTIAL_MISSING',
  'LINE_CREDENTIAL_UNVERIFIED', 'READINESS_UNAVAILABLE',
  ...PHARMACY_READINESS_REASON_CODES,
] as const;

export type PharmacyConfigurationReasonCode =
  (typeof PHARMACY_CONFIGURATION_REASON_CODES)[number];
export type PharmacyConfigurationStatus = 'READY' | 'BLOCKED' | 'UNVERIFIED';

type FeatureReadiness = {
  status: PharmacyConfigurationStatus;
  capabilityEnabled: boolean;
  reasonCodes: readonly PharmacyConfigurationReasonCode[];
};

export type PharmacyConfigurationDoctorInput = {
  accountId: string;
  checkedAt: string;
  tenantMapped: boolean;
  tenantActive: boolean;
  accountActive: boolean;
  staffAssigned: boolean;
  capabilityConfigured: boolean;
  botIdentityConfigured: boolean;
  liffIdConfigured: boolean;
  liffOriginValid: boolean;
  liffEndpointStatus: 'READY' | 'UNVERIFIED';
  loginChannelConfigured: boolean;
  messagingCredentialsConfigured: boolean;
  loginCredentialConfigured: boolean;
  credentialStatus: 'READY' | 'UNVERIFIED';
  readiness: {
    electronicPrescription: FeatureReadiness;
    emergencyContraception: FeatureReadiness;
    richMenu: FeatureReadiness;
  } | null;
};

type PharmacyConfigurationSnapshot = {
  tenant_id: string | null;
  tenant_status: string | null;
  is_active: number;
  liff_id: string | null;
  login_channel_id: string | null;
  active_staff_assignment_count: number;
  capability_config_count: number;
  bot_identity_count: number;
  messaging_credential_count: number;
  login_credential_count: number;
};

type CanonicalReadiness = NonNullable<PharmacyConfigurationDoctorInput['readiness']> & {
  checkedAt?: string;
};

export type PharmacyConfigurationCheck = {
  key: string;
  required: boolean;
  status: PharmacyConfigurationStatus;
  reasonCodes: PharmacyConfigurationReasonCode[];
  impact: string;
  fixHref: string;
};

function check(
  key: string,
  ready: boolean,
  reasonCode: PharmacyConfigurationReasonCode,
  impact: string,
  fixHref: string,
): PharmacyConfigurationCheck {
  return {
    key, required: true, status: ready ? 'READY' : 'BLOCKED',
    reasonCodes: ready ? [] : [reasonCode], impact, fixHref,
  };
}

function featureCheck(
  key: string,
  value: FeatureReadiness,
  impact: string,
  fixHref: string,
): PharmacyConfigurationCheck {
  if (!value.capabilityEnabled) {
    return { key, required: false, status: 'READY', reasonCodes: [], impact, fixHref };
  }
  return {
    key, required: true, status: value.status,
    reasonCodes: [...value.reasonCodes], impact, fixHref,
  };
}

export function buildPharmacyConfigurationDoctor(input: PharmacyConfigurationDoctorInput) {
  const checks: PharmacyConfigurationCheck[] = [
    check('tenantMapping', input.tenantMapped, 'TENANT_MAPPING_MISSING', '薬局accountをtenantから利用できません。', '/accounts'),
    check('tenant', input.tenantActive, 'TENANT_INACTIVE', 'tenantが停止中です。', '/accounts'),
    check('account', input.accountActive, 'ACCOUNT_INACTIVE', 'LINE accountが停止中です。', '/accounts'),
    check('staffAssignment', input.staffAssigned, 'STAFF_ASSIGNMENT_MISSING', '担当staffが薬局accountを操作できません。', '/staff'),
    check('capabilityConfig', input.capabilityConfigured, 'CAPABILITY_CONFIG_MISSING', '機能ON/OFF設定が未作成です。', '/pharmacy-features'),
    check('botIdentity', input.botIdentityConfigured, 'BOT_IDENTITY_MISSING', 'Messaging APIのbot identityが未確認です。', '/accounts'),
  ];

  const liffReasons: PharmacyConfigurationReasonCode[] = [];
  let liffStatus: PharmacyConfigurationStatus = 'READY';
  if (!input.liffIdConfigured) {
    liffReasons.push('LIFF_ID_MISSING');
    liffStatus = 'BLOCKED';
  } else if (!input.liffOriginValid) {
    liffReasons.push('LIFF_PUBLIC_ORIGIN_INVALID');
    liffStatus = 'BLOCKED';
  } else if (input.liffEndpointStatus !== 'READY') {
    liffReasons.push('LIFF_ENDPOINT_UNVERIFIED');
    liffStatus = 'UNVERIFIED';
  }
  checks.push({
    key: 'liffEndpoint', required: true, status: liffStatus, reasonCodes: liffReasons,
    impact: 'LIFFの薬局画面を安全に起動できません。', fixHref: '/accounts',
  });

  const credentialReasons: PharmacyConfigurationReasonCode[] = [];
  if (!input.loginChannelConfigured) credentialReasons.push('LOGIN_CHANNEL_MISSING');
  if (!input.messagingCredentialsConfigured) credentialReasons.push('MESSAGING_CREDENTIAL_MISSING');
  if (!input.loginCredentialConfigured) credentialReasons.push('LOGIN_CREDENTIAL_MISSING');
  const credentialsBlocked = credentialReasons.length > 0;
  if (!credentialsBlocked && input.credentialStatus !== 'READY') {
    credentialReasons.push('LINE_CREDENTIAL_UNVERIFIED');
  }
  checks.push({
    key: 'lineCredentials', required: true,
    status: credentialsBlocked ? 'BLOCKED' : credentialReasons.length ? 'UNVERIFIED' : 'READY',
    reasonCodes: credentialReasons,
    impact: 'LINE連携またはrich-menu反映を実行できません。', fixHref: '/accounts',
  });

  if (!input.readiness) {
    checks.push({
      key: 'readiness', required: true, status: 'UNVERIFIED',
      reasonCodes: ['READINESS_UNAVAILABLE'], impact: '機能別の準備状態を確認できません。',
      fixHref: '/pharmacy-features',
    });
  } else {
    checks.push(
      featureCheck('electronicPrescription', input.readiness.electronicPrescription, '電子処方箋受付を開始できません。', '/myna'),
      featureCheck('emergencyContraception', input.readiness.emergencyContraception, '緊急避妊薬受付を開始できません。', '/emergency-contraception'),
      featureCheck('richMenu', input.readiness.richMenu, 'rich-menuを現在の設定として確認できません。', '/rich-menus'),
    );
  }

  const requiredFailures = checks.filter((item) => item.required && item.status !== 'READY');
  const reasonCodes = requiredFailures.flatMap((item) => item.reasonCodes);
  return {
    accountId: input.accountId,
    checkedAt: input.checkedAt,
    status: requiredFailures.some((item) => item.status === 'BLOCKED')
      ? 'BLOCKED' as const
      : requiredFailures.length > 0 ? 'UNVERIFIED' as const : 'READY' as const,
    reasonCodes,
    checks,
  };
}

export async function getPharmacyConfigurationDoctor(input: {
  db: D1Database;
  tenantId: string;
  accountId: string;
  liffPublicUrl?: string;
  credentialKey?: string;
  readiness: CanonicalReadiness | null;
}) {
  const row = await input.db.prepare(
    `SELECT mapping.tenant_id, tenant.status AS tenant_status, account.is_active,
            account.liff_id, account.login_channel_id,
            (SELECT COUNT(*) FROM pharmacy_staff_accounts AS assignment
              INNER JOIN staff_members AS staff ON staff.id = assignment.staff_id
              INNER JOIN tenant_staff_memberships AS membership
                      ON membership.staff_id = assignment.staff_id
                     AND membership.tenant_id = mapping.tenant_id
               WHERE assignment.line_account_id = account.id AND assignment.is_active = 1
                 AND staff.is_active = 1 AND membership.is_active = 1) AS active_staff_assignment_count,
            (SELECT COUNT(*) FROM pharmacy_account_capabilities AS capability
              WHERE capability.line_account_id = account.id AND capability.mode = 'pharmacy') AS capability_config_count,
            (SELECT COUNT(*) FROM pharmacy_line_channel_identities AS identity
              WHERE identity.line_account_id = account.id) AS bot_identity_count,
            (SELECT COUNT(*) FROM pharmacy_line_credentials AS credential
              WHERE credential.tenant_id = mapping.tenant_id
                AND credential.line_account_id = account.id
                AND credential.credential_kind IN ('channel_access_token', 'channel_secret')) AS messaging_credential_count,
            (SELECT COUNT(*) FROM pharmacy_line_credentials AS credential
              WHERE credential.tenant_id = mapping.tenant_id
                AND credential.line_account_id = account.id
                AND credential.credential_kind = 'login_channel_secret') AS login_credential_count
       FROM line_accounts AS account
       LEFT JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = account.id AND mapping.tenant_id = ?
       LEFT JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
      WHERE account.id = ? LIMIT 1`,
  ).bind(input.tenantId, input.accountId).first<PharmacyConfigurationSnapshot>();

  let liffOriginValid = false;
  if (row?.liff_id && input.liffPublicUrl) {
    try {
      const url = new URL('/', input.liffPublicUrl);
      liffOriginValid = url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      liffOriginValid = false;
    }
  }

  let credentialStatus: 'READY' | 'UNVERIFIED' = 'UNVERIFIED';
  if (row?.tenant_id === input.tenantId && row.messaging_credential_count === 2 &&
      row.login_credential_count === 1 && input.credentialKey) {
    try {
      const values = await Promise.all([
        readLineCredential(input.db, input.credentialKey, {
          tenantId: input.tenantId, lineAccountId: input.accountId, kind: 'channel_access_token',
        }),
        readLineCredential(input.db, input.credentialKey, {
          tenantId: input.tenantId, lineAccountId: input.accountId, kind: 'channel_secret',
        }),
        readLineCredential(input.db, input.credentialKey, {
          tenantId: input.tenantId, lineAccountId: input.accountId, kind: 'login_channel_secret',
        }),
      ]);
      credentialStatus = values.every((value) => typeof value === 'string' && value.length > 0)
        ? 'READY' : 'UNVERIFIED';
    } catch {
      credentialStatus = 'UNVERIFIED';
    }
  }

  return buildPharmacyConfigurationDoctor({
    accountId: input.accountId,
    checkedAt: input.readiness?.checkedAt ?? new Date().toISOString(),
    tenantMapped: row?.tenant_id === input.tenantId,
    tenantActive: row?.tenant_status === 'active',
    accountActive: row?.is_active === 1,
    staffAssigned: (row?.active_staff_assignment_count ?? 0) > 0,
    capabilityConfigured: (row?.capability_config_count ?? 0) > 0,
    botIdentityConfigured: (row?.bot_identity_count ?? 0) > 0,
    liffIdConfigured: Boolean(row?.liff_id),
    liffOriginValid,
    liffEndpointStatus: 'UNVERIFIED',
    loginChannelConfigured: Boolean(row?.login_channel_id),
    messagingCredentialsConfigured: row?.messaging_credential_count === 2,
    loginCredentialConfigured: row?.login_credential_count === 1,
    credentialStatus,
    readiness: input.readiness,
  });
}
