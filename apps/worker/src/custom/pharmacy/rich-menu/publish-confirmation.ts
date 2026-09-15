import {
  decodeBase64UrlLenient,
  hmacSha256,
  sameText,
  toBase64Url,
} from '../crypto-utils.js';

export const PHARMACY_RICH_MENU_PUBLISH_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

export type PharmacyRichMenuPublishConfirmation = {
  tenantId: string;
  accountId: string;
  groupId: string;
  confirmationId: string;
  evidenceDigest: string;
  expiresAt: number;
};

export type PharmacyRichMenuResumeConfirmation = PharmacyRichMenuPublishConfirmation & {
  operationId: string;
  publishPhase: 'intent_recorded' | 'remote_created' | 'image_uploaded' | 'alias_created';
};

const decodeBase64Url = decodeBase64UrlLenient;

function hmac(secret: string, value: string): Promise<string> {
  return hmacSha256(secret, value).then(toBase64Url);
}

const same = sameText;

export async function signPharmacyRichMenuPublishConfirmation(
  secret: string,
  payload: PharmacyRichMenuPublishConfirmation,
): Promise<string> {
  if (!secret || !payload.tenantId || !payload.accountId || !payload.groupId ||
      !payload.confirmationId || payload.confirmationId.length > 128 ||
      !/^[a-f0-9]{64}$/u.test(payload.evidenceDigest) || !Number.isFinite(payload.expiresAt)) {
    throw new Error('invalid pharmacy rich-menu publish confirmation');
  }
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signed = `prmp1.${encoded}`;
  return `${signed}.${await hmac(secret, signed)}`;
}

export async function verifyPharmacyRichMenuPublishConfirmation(
  secret: string,
  token: string,
): Promise<PharmacyRichMenuPublishConfirmation | null> {
  if (!secret || token.length > 4096) return null;
  const [version, encoded, signature, extra] = token.split('.');
  if (version !== 'prmp1' || !encoded || !signature || extra) return null;
  const signed = `${version}.${encoded}`;
  if (!same(await hmac(secret, signed), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as
      Partial<PharmacyRichMenuPublishConfirmation>;
    if (typeof payload.tenantId !== 'string' || typeof payload.accountId !== 'string' ||
        typeof payload.groupId !== 'string' || typeof payload.confirmationId !== 'string' ||
        !payload.confirmationId || payload.confirmationId.length > 128 ||
        typeof payload.evidenceDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(payload.evidenceDigest) || typeof payload.expiresAt !== 'number' ||
        payload.expiresAt < Date.now()) return null;
    return payload as PharmacyRichMenuPublishConfirmation;
  } catch {
    return null;
  }
}

export async function signPharmacyRichMenuResumeConfirmation(
  secret: string,
  payload: PharmacyRichMenuResumeConfirmation,
): Promise<string> {
  if (!secret || !payload.tenantId || !payload.accountId || !payload.groupId ||
      !payload.operationId || !payload.confirmationId || payload.confirmationId.length > 128 ||
      !['intent_recorded', 'remote_created', 'image_uploaded', 'alias_created']
        .includes(payload.publishPhase) ||
      !/^[a-f0-9]{64}$/u.test(payload.evidenceDigest) || !Number.isFinite(payload.expiresAt)) {
    throw new Error('invalid pharmacy rich-menu resume confirmation');
  }
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signed = `prmr1.${encoded}`;
  return `${signed}.${await hmac(secret, signed)}`;
}

export async function verifyPharmacyRichMenuResumeConfirmation(
  secret: string,
  token: string,
): Promise<PharmacyRichMenuResumeConfirmation | null> {
  if (!secret || token.length > 4096) return null;
  const [version, encoded, signature, extra] = token.split('.');
  if (version !== 'prmr1' || !encoded || !signature || extra) return null;
  const signed = `${version}.${encoded}`;
  if (!same(await hmac(secret, signed), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as
      Partial<PharmacyRichMenuResumeConfirmation>;
    if (typeof payload.tenantId !== 'string' || typeof payload.accountId !== 'string' ||
        typeof payload.groupId !== 'string' || typeof payload.operationId !== 'string' ||
        !payload.operationId || typeof payload.confirmationId !== 'string' ||
        !payload.confirmationId || payload.confirmationId.length > 128 ||
        (payload.publishPhase !== 'intent_recorded' && payload.publishPhase !== 'remote_created' &&
          payload.publishPhase !== 'image_uploaded' && payload.publishPhase !== 'alias_created') ||
        typeof payload.evidenceDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(payload.evidenceDigest) || typeof payload.expiresAt !== 'number' ||
        payload.expiresAt < Date.now()) return null;
    return payload as PharmacyRichMenuResumeConfirmation;
  } catch {
    return null;
  }
}
