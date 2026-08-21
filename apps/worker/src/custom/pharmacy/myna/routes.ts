import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { getPharmacyAccountId } from '../account.js';
import { enqueueActivityForAccount } from '../activity-notifications/repository.js'; // custom:pharmacy-activity-notifications
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';
import { readJsonObject } from '../json.js';
import {
  resolvePrescriptionPatient,
  type PrescriptionPatient,
} from '../prescriptions/patient.js';
import {
  createMynaHandoff,
  getActivePatientMynaHandoff,
  getAdminMynaHandoff,
  listMynaHandoffs,
  markMynaLaunchRequested,
  recordMynaPatientReport,
  recordMynaVerification,
} from './repository.js';
import {
  MYNA_HANDOFF_STATUSES,
  type MynaHandoffStatus,
  type MynaMethod,
  type MynaPatientReport,
  type MynaVerificationStatus,
} from './state.js';
import {
  getActiveMynaEndpoint,
  getAdminMynaEndpoint,
  markMynaEndpointVerified,
  saveMynaEndpoint,
  setMynaEndpointEnabled,
} from './endpoint-repository.js';
import { base64UrlDecode, base64UrlEncode, launchTokenKey } from './endpoint.js';

type MynaBindings = Pick<Env['Bindings'], 'DB' | 'WORKER_PUBLIC_URL'> & {
  LINE_CHANNEL_ID?: string;
  MYNA_ENDPOINT_ENCRYPTION_KEY?: string;
  MYNA_ALLOWED_HOSTS?: string;
};

type MynaEnv = {
  Bindings: MynaBindings;
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    mynaPatient: PrescriptionPatient;
  };
};

export const mynaRoutes = new Hono<MynaEnv>();

const METHODS = new Set<MynaMethod>(['E_PRESCRIPTION', 'PAPER', 'MEDICAL_INSTITUTION_SENT']);
const HANDOFF_STATUSES = new Set<MynaHandoffStatus>(MYNA_HANDOFF_STATUSES);
const PATIENT_REPORTS = new Set<MynaPatientReport>([
  'COMPLETED', 'NO_PRESCRIPTION_FOUND', 'FAILED', 'SWITCH_TO_PAPER',
]);
const VERIFICATIONS = new Set<MynaVerificationStatus>([
  'E_PRESCRIPTION_RECEIVED', 'CONSENT_ONLY_OR_NO_PRESCRIPTION', 'NO_RECORD_FOUND',
  'SUBMITTED_TO_OTHER_PHARMACY', 'PRESCRIPTION_EXPIRED', 'PAPER_FALLBACK',
  'PATIENT_MISMATCH', 'MANUAL_EXCEPTION',
]);
const HIGH_RISK_VERIFICATIONS = new Set<MynaVerificationStatus>([
  'SUBMITTED_TO_OTHER_PHARMACY', 'PRESCRIPTION_EXPIRED', 'PATIENT_MISMATCH', 'MANUAL_EXCEPTION',
]);

function encryptionSecret(c: { env: MynaBindings }): string | null {
  return c.env.MYNA_ENDPOINT_ENCRYPTION_KEY || null;
}

function allowedHosts(c: { env: MynaBindings }): string[] {
  return (c.env.MYNA_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Token lifetime: 30 min, matching the Myna handoff expiry set in
// repository.ts createMynaHandoff (expiresAt = now + 30 * 60_000). A launch
// link is worthless once its handoff has expired, so the token need not
// outlive it.
const LAUNCH_TOKEN_TTL_MS = 30 * 60_000;

/**
 * Signs a short-lived `lineAccountId|exp` token so `/r/myna/:token` never
 * exposes the tenant alias (or any other stable identifier) in a public URL.
 */
async function signLaunchToken(secret: string, lineAccountId: string): Promise<string> {
  const payload = `${lineAccountId}|${Date.now() + LAUNCH_TOKEN_TTL_MS}`;
  const signature = await crypto.subtle.sign(
    'HMAC', await launchTokenKey(secret), textEncoder.encode(payload),
  );
  return `${base64UrlEncode(textEncoder.encode(payload))}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verifies signature + expiry via crypto.subtle.verify (constant-time by construction). */
async function verifyLaunchToken(secret: string, token: string): Promise<string | null> {
  const [payloadPart, sigPart] = token.split('.');
  if (!payloadPart || !sigPart) return null;
  let payload: string;
  let signature: Uint8Array;
  try {
    payload = textDecoder.decode(base64UrlDecode(payloadPart));
    signature = base64UrlDecode(sigPart);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    'HMAC', await launchTokenKey(secret), signature, textEncoder.encode(payload),
  );
  if (!valid) return null;
  const match = /^(.+)\|(\d+)$/.exec(payload);
  if (!match) return null;
  const [, lineAccountId, expText] = match;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return lineAccountId;
}

async function launchUrl(c: { req: { url: string }; env: MynaBindings }, lineAccountId: string): Promise<string> {
  const origin = c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin;
  const secret = encryptionSecret(c);
  if (!secret) throw new Error('Myna endpoint encryption is not configured');
  const token = await signLaunchToken(secret, lineAccountId);
  return `${origin}/r/myna/${token}?openExternalBrowser=1`;
}

async function patientGate(c: Context<MynaEnv>, next: Next) {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env as Env['Bindings']);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('mynaPatient', patient);
  return next();
}

async function adminGate(c: Context<MynaEnv>, next: Next) {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  return next();
}

// Patient routes authenticate with the LINE ID token, not the admin API token.
mynaRoutes.use('/api/liff/pharmacy/myna-handoffs', patientGate);
mynaRoutes.use('/api/liff/pharmacy/myna-handoffs/*', patientGate);
mynaRoutes.use('/api/custom/pharmacy/myna-handoffs', adminGate);
mynaRoutes.use('/api/custom/pharmacy/myna-handoffs/*', adminGate);
mynaRoutes.use('/api/custom/pharmacy/myna-endpoint', adminGate);
mynaRoutes.use('/api/custom/pharmacy/myna-endpoint/*', adminGate);

mynaRoutes.post('/api/liff/pharmacy/myna-handoffs', async (c) => {
  const patient = c.get('mynaPatient');
  const body = await readJsonObject(c.req);
  if (!body || typeof body.method !== 'string' || !METHODS.has(body.method as MynaMethod) ||
      typeof body.correlationId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.correlationId) ||
      (body.patientId !== undefined && typeof body.patientId !== 'string')) {
    return c.json({ error: 'Invalid Myna handoff' }, 400);
  }
  const method = body.method as MynaMethod;
  const capability = method === 'E_PRESCRIPTION'
    ? 'electronic_prescription'
    : 'prescription_intake';
  if (!(await hasPharmacyCapability(c.env.DB, patient.lineAccountId, capability))) {
    return c.json({ error: 'この受付は現在利用できません', code: 'FEATURE_DISABLED' }, 409);
  }
  const secret = encryptionSecret(c);
  const endpoint = method === 'E_PRESCRIPTION' && secret
    ? await getActiveMynaEndpoint(c.env.DB, patient.lineAccountId, secret)
    : null;
  if (method === 'E_PRESCRIPTION' && !endpoint) {
    return c.json({ error: 'Myna受付URLが設定されていません' }, 503);
  }
  try {
    const result = await createMynaHandoff(c.env.DB, {
      lineAccountId: patient.lineAccountId,
      friendId: patient.friendId,
      patientId: typeof body.patientId === 'string' ? body.patientId : undefined,
      method,
      source: 'LIFF',
      correlationId: body.correlationId,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    return c.json({
      handoff: result.handoff,
      expectation: result.expectation,
      launchUrl: endpoint ? await launchUrl(c, endpoint.line_account_id) : null,
    }, 201);
  } catch (error) {
    return mapMynaError(c, error);
  }
});

mynaRoutes.get('/api/liff/pharmacy/myna-handoffs/active', async (c) => {
  const patient = c.get('mynaPatient');
  const handoff = await getActivePatientMynaHandoff(
    c.env.DB, patient.lineAccountId, patient.friendId,
  );
  return c.json({ handoff }, 200, { 'Cache-Control': 'no-store' });
});

mynaRoutes.post('/api/liff/pharmacy/myna-handoffs/:id/launch', async (c) => {
  const patient = c.get('mynaPatient');
  const secret = encryptionSecret(c);
  if (!secret) return c.json({ error: 'Myna受付URLが設定されていません' }, 503);
  try {
    const current = await getAdminMynaHandoff(c.env.DB, patient.lineAccountId, c.req.param('id'));
    if (!current || current.handoff.friend_id !== patient.friendId) return c.json({ error: 'Myna handoff not found' }, 404);
    if (current.handoff.method !== 'E_PRESCRIPTION') return c.json({ error: 'This handoff does not use Myna受付' }, 400);
    const endpoint = await getActiveMynaEndpoint(c.env.DB, patient.lineAccountId, secret);
    if (!endpoint) return c.json({ error: 'Myna受付URLが設定されていません' }, 503);
    const handoff = await markMynaLaunchRequested(
      c.env.DB, patient.lineAccountId, patient.friendId, c.req.param('id'),
    );
    return c.json({ handoff, launchUrl: await launchUrl(c, endpoint.line_account_id) }, 200, {
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    return mapMynaError(c, error);
  }
});

mynaRoutes.post('/api/liff/pharmacy/myna-handoffs/:id/patient-report', async (c) => {
  const patient = c.get('mynaPatient');
  const body = await readJsonObject(c.req);
  if (!body || typeof body.result !== 'string' || !PATIENT_REPORTS.has(body.result as MynaPatientReport)) {
    return c.json({ error: 'Invalid patient report' }, 400);
  }
  try {
    const handoff = await recordMynaPatientReport(
      c.env.DB, patient.lineAccountId, patient.friendId, c.req.param('id'), body.result as MynaPatientReport,
    );
    return c.json({ handoff });
  } catch (error) {
    return mapMynaError(c, error);
  }
});

// The redirect accepts only a short-lived signed token (see signLaunchToken /
// verifyLaunchToken above) — never the tenant alias or a patient/LINE
// identifier. Invalid, tampered, expired, or unknown-account tokens all get
// the same generic 404 so the response never confirms which case occurred.
mynaRoutes.get('/r/myna/:token', async (c) => {
  const secret = encryptionSecret(c);
  if (!secret) return c.text('Myna受付を利用できません', 503);
  try {
    const lineAccountId = await verifyLaunchToken(secret, c.req.param('token'));
    const endpoint = lineAccountId ? await getActiveMynaEndpoint(c.env.DB, lineAccountId, secret) : null;
    if (!endpoint) return c.text('Myna受付を利用できません', 404);
    return new Response(null, {
      status: 302,
      headers: {
        Location: endpoint.endpoint_url,
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  } catch {
    return c.text('Myna受付を利用できません', 503);
  }
});

mynaRoutes.get('/api/custom/pharmacy/myna-handoffs', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const rawStatus = c.req.query('status');
  if (rawStatus !== undefined && !HANDOFF_STATUSES.has(rawStatus as MynaHandoffStatus)) {
    return c.json({ error: 'Invalid Myna handoff status' }, 400);
  }
  const status = rawStatus as MynaHandoffStatus | undefined;
  try {
    return c.json({ handoffs: await listMynaHandoffs(c.env.DB, lineAccountId, status) });
  } catch (error) {
    return mapMynaError(c, error);
  }
});

mynaRoutes.get('/api/custom/pharmacy/myna-handoffs/:id', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const result = await getAdminMynaHandoff(c.env.DB, lineAccountId, c.req.param('id'));
  return result ? c.json(result) : c.json({ error: 'Myna handoff not found' }, 404);
});

mynaRoutes.post('/api/custom/pharmacy/myna-handoffs/:id/verifications', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const body = await readJsonObject(c.req);
  const status = body?.status as MynaVerificationStatus | undefined;
  if (!body || !status || !VERIFICATIONS.has(status) || typeof body.sourceSystem !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(body.sourceSystem) ||
      (body.reasonCode !== undefined && body.reasonCode !== null && typeof body.reasonCode !== 'string') ||
      (body.sourceReference !== undefined && body.sourceReference !== null && typeof body.sourceReference !== 'string') ||
      (body.note !== undefined && body.note !== null)) {
    return c.json({ error: 'Invalid Myna verification' }, 400);
  }
  if (HIGH_RISK_VERIFICATIONS.has(status) && staff.role === 'staff') {
    return c.json({ error: '薬剤師または管理者の確認が必要です' }, 403);
  }
  try {
    const result = await recordMynaVerification(c.env.DB, {
      lineAccountId,
      handoffId: c.req.param('id'),
      staffId: staff.id,
      status,
      reasonCode: typeof body.reasonCode === 'string' ? body.reasonCode : null,
      sourceSystem: body.sourceSystem,
      sourceReference: typeof body.sourceReference === 'string' ? body.sourceReference : null,
    });
    try {
      await enqueueActivityForAccount(
        c.env.DB, lineAccountId, 'myna_handoff_received',
        `myna-verification:${c.req.param('id')}:${status}`,
      );
    } catch {
      console.error('[pharmacy-myna] activity notification unavailable');
    }
    return c.json(result, 201);
  } catch (error) {
    return mapMynaError(c, error);
  }
});

mynaRoutes.get('/api/custom/pharmacy/myna-endpoint', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  const secret = encryptionSecret(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!secret) return c.json({ error: 'Myna endpoint encryption is not configured' }, 503);
  try {
    return c.json({ endpoint: await getAdminMynaEndpoint(c.env.DB, lineAccountId, secret) });
  } catch {
    return c.json({ error: 'Myna endpoint configuration is invalid' }, 503);
  }
});

mynaRoutes.put('/api/custom/pharmacy/myna-endpoint', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (staff.role === 'staff') return c.json({ error: '管理者権限が必要です' }, 403);
  const lineAccountId = getPharmacyAccountId(c);
  const secret = encryptionSecret(c);
  const body = await readJsonObject(c.req);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!secret) return c.json({ error: 'Myna endpoint encryption is not configured' }, 503);
  if (!body || typeof body.tenantAlias !== 'string' || typeof body.endpointUrl !== 'string' ||
      typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid Myna endpoint config' }, 400);
  try {
    const endpoint = await saveMynaEndpoint(c.env.DB, {
      lineAccountId,
      tenantAlias: body.tenantAlias,
      endpointUrl: body.endpointUrl,
      enabled: body.enabled,
      staffId: staff.id,
      encryptionSecret: secret,
      allowedHosts: allowedHosts(c),
    });
    return c.json({ endpoint });
  } catch (error) {
    return mapMynaError(c, error);
  }
});

mynaRoutes.patch('/api/custom/pharmacy/myna-endpoint', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (staff.role === 'staff') return c.json({ error: '管理者権限が必要です' }, 403);
  const lineAccountId = getPharmacyAccountId(c);
  const secret = encryptionSecret(c);
  const body = await readJsonObject(c.req);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!secret) return c.json({ error: 'Myna endpoint encryption is not configured' }, 503);
  if (!body || typeof body.enabled !== 'boolean' || !Number.isInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 1 ||
      Object.keys(body).some((key) => key !== 'enabled' && key !== 'expectedRevision')) {
    return c.json({ error: 'enabled and expectedRevision are required' }, 400);
  }
  try {
    return c.json({ endpoint: await setMynaEndpointEnabled(
      c.env.DB, lineAccountId, body.enabled, Number(body.expectedRevision), staff.id, secret,
    ) });
  } catch (error) {
    if (String(error).includes('stale Myna endpoint revision')) {
      return c.json({ error: 'Myna endpoint configuration changed' }, 409);
    }
    if (String(error).includes('Myna endpoint not found')) {
      return c.json({ error: 'Myna endpoint not found' }, 404);
    }
    return mapMynaError(c, error);
  }
});

mynaRoutes.post('/api/custom/pharmacy/myna-endpoint/verification', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (staff.role === 'staff') return c.json({ error: '管理者権限が必要です' }, 403);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const body = await readJsonObject(c.req);
  if (!body || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 ||
      Object.keys(body).some((key) => key !== 'expectedRevision')) {
    return c.json({ error: 'expectedRevision is required' }, 400);
  }
  try {
    return c.json({ checkedAt: await markMynaEndpointVerified(
      c.env.DB, lineAccountId, Number(body.expectedRevision),
    ) });
  } catch (error) {
    if (String(error).includes('stale Myna endpoint revision')) {
      return c.json({ error: 'Myna endpoint configuration changed' }, 409);
    }
    return mapMynaError(c, error);
  }
});

function mapMynaError(c: Context<MynaEnv>, error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (message === 'FEATURE_DISABLED') {
    return c.json({ error: 'この受付は現在利用できません', code: 'FEATURE_DISABLED' }, 409);
  }
  if (message === 'Myna handoff not found' || message === 'Myna expectation not found' || message === 'patient not found') {
    return c.json({ error: message === 'patient not found' ? 'Patient not found' : 'Myna handoff not found' }, 404);
  }
  if (message.includes('expired') || message.includes('conflict') || message.includes('closed')) {
    return c.json({ error: 'Myna受付の状態が変わりました。最新状態を確認してください。' }, 409);
  }
  if (message.includes('invalid Myna')) return c.json({ error: 'Invalid Myna input' }, 400);
  if (message.includes('integrity') || message.includes('encrypted')) return c.json({ error: 'Myna endpoint configuration is invalid' }, 503);
  if (message.includes('UNIQUE')) return c.json({ error: 'Myna endpoint configuration already exists' }, 409);
  throw error;
}
