// The pharmacy tenant is the 個人情報取扱事業者 (APPI data controller) for everything
// it collects through this system; the platform operator is only the 受託者
// (processor). Rows in pharmacy_tenant_privacy_policy are authored by tenant staff.
// Patient-facing reads may use the immutable platform baseline, but it is never
// stored with a fabricated updated_by attribution.

export interface TenantPrivacyPolicy {
  line_account_id: string;
  purpose_text: string;
  purpose_url: string;
  contact_point: string;
  entrustment_text: string;
  policy_version: number;
  content_hash: string;
  updated_at: string;
}

export interface EffectiveTenantPrivacyPolicy extends TenantPrivacyPolicy {
  source: 'tenant' | 'platform_default';
}

export interface TenantPrivacyPolicyInput {
  lineAccountId: string;
  staffId: string;
  purposeText: string;
  purposeUrl: string;
  contactPoint: string;
  entrustmentText: string;
}

const LIMITS = {
  purposeText: 4000,
  purposeUrl: 2000,
  contactPoint: 1000,
  entrustmentText: 2000,
} as const;

export const PLATFORM_DEFAULT_POLICY_VERSION = 1;
export const PLATFORM_DEFAULT_POLICY_EFFECTIVE_AT = '2026-08-31T00:00:00.000Z';
export const PLATFORM_DEFAULT_POLICY_FIELDS = {
  purposeText: '本サービスでご入力いただく個人情報は、当薬局が個人情報取扱事業者として、患者受付、調剤・服薬指導その他の薬局サービスの提供、医療保険事務、およびこれらに必要な患者さまへの連絡のために利用します。',
  purposeUrl: '',
  contactPoint: '個人情報の取扱いに関するお問い合わせは、当薬局へお申し出ください。',
  entrustmentText: '当薬局は、本サービスの提供に必要な範囲で、個人情報の取扱いの一部を本サービスの運営事業者に委託し、委託先を必要かつ適切に監督します。',
} as const;
export const PLATFORM_DEFAULT_POLICY_HASH =
  'df7e30e12108c2e4fd8e568ba7d47e753fae5aa71f28273c87c562d92486e6fc';

/** SHA-256 over the canonical policy text, so a stored hash proves the exact wording. */
export async function policyContentHash(policy: {
  purposeText: string;
  purposeUrl: string;
  contactPoint: string;
  entrustmentText: string;
}): Promise<string> {
  const canonical = JSON.stringify([
    policy.purposeText, policy.purposeUrl, policy.contactPoint, policy.entrustmentText,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function getTenantPrivacyPolicy(
  db: D1Database,
  lineAccountId: string,
): Promise<TenantPrivacyPolicy | null> {
  return db.prepare(
    `SELECT line_account_id, purpose_text, purpose_url, contact_point, entrustment_text,
            policy_version, content_hash, updated_at
       FROM pharmacy_tenant_privacy_policy
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<TenantPrivacyPolicy>();
}

export async function getEffectiveTenantPrivacyPolicy(
  db: D1Database,
  lineAccountId: string,
): Promise<EffectiveTenantPrivacyPolicy | null> {
  const stored = await getTenantPrivacyPolicy(db, lineAccountId);
  if (stored) return { ...stored, source: 'tenant' };
  const account = await db.prepare(
    `SELECT 1 AS found FROM line_accounts WHERE id = ? AND is_active = 1`,
  ).bind(lineAccountId).first<{ found: number }>();
  if (!account) return null;
  return {
    line_account_id: lineAccountId,
    purpose_text: PLATFORM_DEFAULT_POLICY_FIELDS.purposeText,
    purpose_url: PLATFORM_DEFAULT_POLICY_FIELDS.purposeUrl,
    contact_point: PLATFORM_DEFAULT_POLICY_FIELDS.contactPoint,
    entrustment_text: PLATFORM_DEFAULT_POLICY_FIELDS.entrustmentText,
    policy_version: PLATFORM_DEFAULT_POLICY_VERSION,
    content_hash: PLATFORM_DEFAULT_POLICY_HASH,
    updated_at: PLATFORM_DEFAULT_POLICY_EFFECTIVE_AT,
    source: 'platform_default',
  };
}

export async function saveTenantPrivacyPolicy(
  db: D1Database,
  input: TenantPrivacyPolicyInput,
): Promise<void> {
  const policy = {
    purposeText: input.purposeText.trim(),
    purposeUrl: input.purposeUrl.trim(),
    contactPoint: input.contactPoint.trim(),
    entrustmentText: input.entrustmentText.trim(),
  };
  if (!policy.purposeText || !policy.contactPoint || !policy.entrustmentText ||
      policy.purposeText.length > LIMITS.purposeText ||
      policy.purposeUrl.length > LIMITS.purposeUrl ||
      policy.contactPoint.length > LIMITS.contactPoint ||
      policy.entrustmentText.length > LIMITS.entrustmentText ||
      (policy.purposeUrl !== '' && !/^https:\/\/\S+$/.test(policy.purposeUrl))) {
    throw new Error('invalid privacy policy');
  }
  const hash = await policyContentHash(policy);
  const initialVersion = hash === PLATFORM_DEFAULT_POLICY_HASH
    ? PLATFORM_DEFAULT_POLICY_VERSION
    : PLATFORM_DEFAULT_POLICY_VERSION + 1;
  const now = new Date().toISOString();
  // policy_version advances only when the text changed, so a version is a stable
  // reference to one exact wording rather than to an edit session.
  await db.prepare(
    `INSERT INTO pharmacy_tenant_privacy_policy
       (line_account_id, purpose_text, purpose_url, contact_point, entrustment_text,
        policy_version, content_hash, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id) DO UPDATE SET
       purpose_text = excluded.purpose_text,
       purpose_url = excluded.purpose_url,
       contact_point = excluded.contact_point,
       entrustment_text = excluded.entrustment_text,
       policy_version = pharmacy_tenant_privacy_policy.policy_version +
         (CASE WHEN pharmacy_tenant_privacy_policy.content_hash = excluded.content_hash THEN 0 ELSE 1 END),
       content_hash = excluded.content_hash,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.lineAccountId, policy.purposeText, policy.purposeUrl, policy.contactPoint,
    policy.entrustmentText, initialVersion, hash, input.staffId, now, now,
  ).run();
}
