// The pharmacy tenant is the 個人情報取扱事業者 (APPI data controller) for everything
// it collects through this system; the platform operator is only the 受託者
// (processor). Every string in this table is authored by the tenant's own admin, so
// nothing here may be defaulted to platform-operator wording.

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
  const now = new Date().toISOString();
  // policy_version advances only when the text changed, so a version is a stable
  // reference to one exact wording rather than to an edit session.
  await db.prepare(
    `INSERT INTO pharmacy_tenant_privacy_policy
       (line_account_id, purpose_text, purpose_url, contact_point, entrustment_text,
        policy_version, content_hash, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
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
    policy.entrustmentText, hash, input.staffId, now, now,
  ).run();
}
