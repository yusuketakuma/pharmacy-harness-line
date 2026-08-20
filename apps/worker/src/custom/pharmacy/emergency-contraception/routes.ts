import { Hono, type Context } from 'hono';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { readJsonObject } from '../json.js';
import { resolvePrescriptionPatient, type PrescriptionPatient } from '../prescriptions/patient.js';
import {
  cancelEmergencySlot,
  cancelOwnerEmergencyIntake,
  createEmergencyIntake,
  createEmergencySlot,
  getEmergencyAdminConfig,
  getEmergencyServiceOverview,
  listAdminEmergencyIntakes,
  listOwnerEmergencyIntakes,
  saveEmergencySettings,
  setEmergencyInventory,
  setEmergencyPharmacist,
  transitionEmergencyIntake,
  type EmergencySafeContactMode,
} from './repository.js';

type EmergencyRouteEnv = {
  Bindings: Env['Bindings'] & { PHARMACY_PHI_KEY_V1?: string };
  Variables: Env['Variables'] & {
    emergencyPatient: PrescriptionPatient;
    emergencyTenantId: string;
  };
};

export const emergencyContraceptionRoutes = new Hono<EmergencyRouteEnv>();

emergencyContraceptionRoutes.use('/api/liff/pharmacy/emergency-contraception/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('emergencyPatient', patient);
  c.set('emergencyTenantId', identity.tenantId);
  return next();
});

emergencyContraceptionRoutes.get('/api/liff/pharmacy/emergency-contraception', async (c) => {
  const owner = c.get('emergencyPatient');
  const [service, intakes] = await Promise.all([
    getEmergencyServiceOverview(c.env.DB, owner.lineAccountId),
    listOwnerEmergencyIntakes(c.env.DB, owner.lineAccountId, owner.friendId),
  ]);
  return c.json({ service, intakes });
});

emergencyContraceptionRoutes.post('/api/liff/pharmacy/emergency-contraception/intakes', async (c) => {
  if (!c.env.PHARMACY_PHI_KEY_V1) {
    return c.json({ error: '現在この受付を利用できません' }, 503);
  }
  const body = await readJsonObject(c.req);
  if (!body || typeof body.slotId !== 'string' || typeof body.intercourseAt !== 'string' ||
      typeof body.intercourseTimeUnknown !== 'boolean' || typeof body.age !== 'number' ||
      typeof body.recentPurchaseCount !== 'number' || typeof body.patientWillVisit !== 'boolean' ||
      typeof body.acceptsInPersonDose !== 'boolean' || typeof body.safeContactMode !== 'string' ||
      typeof body.consentVersion !== 'string' ||
      typeof body.manufacturerCheckAcknowledged !== 'boolean' ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
  const owner = c.get('emergencyPatient');
  try {
    const intake = await createEmergencyIntake(c.env.DB, {
      tenantId: c.get('emergencyTenantId'),
      lineAccountId: owner.lineAccountId,
      friendId: owner.friendId,
      slotId: body.slotId,
      intercourseAt: body.intercourseAt,
      intercourseTimeUnknown: body.intercourseTimeUnknown,
      age: body.age,
      recentPurchaseCount: body.recentPurchaseCount,
      patientWillVisit: body.patientWillVisit,
      acceptsInPersonDose: body.acceptsInPersonDose,
      safeContactMode: body.safeContactMode as EmergencySafeContactMode,
      consentVersion: body.consentVersion,
      manufacturerCheckAcknowledged: body.manufacturerCheckAcknowledged,
      idempotencyKey: body.idempotencyKey,
      encryptionSecret: c.env.PHARMACY_PHI_KEY_V1,
    });
    return c.json({ intake }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/stock|slot|conflict/i.test(message)) {
      return c.json({ error: '選択した枠を確保できませんでした。最新の空きを確認してください' }, 409);
    }
    if (/outside_72_hours|presence_required|in_person_dose_required/i.test(message)) {
      return c.json({ error: 'この条件では仮受付できません。案内先をご確認ください' }, 422);
    }
    if (/not ready|not configured|encryption/i.test(message)) {
      return c.json({ error: '現在この受付を利用できません' }, 503);
    }
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
});

emergencyContraceptionRoutes.post('/api/liff/pharmacy/emergency-contraception/intakes/:id/cancel', async (c) => {
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedVersion !== 'number' ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: '取消内容を確認してください' }, 400);
  }
  const owner = c.get('emergencyPatient');
  try {
    const intake = await cancelOwnerEmergencyIntake(c.env.DB, {
      lineAccountId: owner.lineAccountId,
      friendId: owner.friendId,
      intakeId: c.req.param('id'),
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ intake });
  } catch {
    return c.json({ error: '取消できませんでした。最新の状態を確認してください' }, 409);
  }
});

function staffScope(c: Context<EmergencyRouteEnv>): {
  lineAccountId: string;
  staff: Env['Variables']['staff'];
} | Response {
  const lineAccountId = c.get('pharmacyLineAccountId');
  const staff = c.get('staff');
  if (!lineAccountId || !staff) return c.json({ error: 'Unauthorized' }, 401);
  return { lineAccountId, staff };
}

function ownerOrAdmin(role: Env['Variables']['staff']['role']): boolean {
  return role === 'owner' || role === 'admin';
}

emergencyContraceptionRoutes.get('/api/custom/pharmacy/emergency-contraception/config', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  return c.json(await getEmergencyAdminConfig(c.env.DB, scope.lineAccountId));
});

emergencyContraceptionRoutes.put('/api/custom/pharmacy/emergency-contraception/config', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid settings' }, 400);
  try {
    await saveEmergencySettings(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      staffId: scope.staff.id,
      enabled: body.enabled === true,
      pharmacyRegistrationNumber: String(body.pharmacyRegistrationNumber ?? ''),
      productCode: String(body.productCode ?? ''),
      manufacturerCheckUrl: String(body.manufacturerCheckUrl ?? ''),
      privacyPolicyUrl: String(body.privacyPolicyUrl ?? ''),
      privacyContact: String(body.privacyContact ?? ''),
      purposeText: String(body.purposeText ?? ''),
      consentVersion: String(body.consentVersion ?? ''),
      retentionDays: Number(body.retentionDays),
      consultationMinutes: Number(body.consultationMinutes),
      reservationTtlMinutes: Number(body.reservationTtlMinutes),
      privacySpaceReady: body.privacySpaceReady === true,
      drinkingWaterReady: body.drinkingWaterReady === true,
      partnerClinicUrl: String(body.partnerClinicUrl ?? ''),
      supportCenterUrl: String(body.supportCenterUrl ?? ''),
    });
    return c.body(null, 204);
  } catch {
    return c.json({ error: '設定内容を確認してください' }, 400);
  }
});

emergencyContraceptionRoutes.put('/api/custom/pharmacy/emergency-contraception/pharmacists/:staffId', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.registrationNumber !== 'string' || typeof body.active !== 'boolean') {
    return c.json({ error: '登録内容を確認してください' }, 400);
  }
  try {
    await setEmergencyPharmacist(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      staffId: c.req.param('staffId'),
      registrationNumber: body.registrationNumber,
      active: body.active,
    });
    return c.body(null, 204);
  } catch {
    return c.json({ error: '対象スタッフを登録できませんでした' }, 400);
  }
});

emergencyContraceptionRoutes.post('/api/custom/pharmacy/emergency-contraception/slots', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.pharmacistStaffId !== 'string' || typeof body.startsAt !== 'string' ||
      typeof body.endsAt !== 'string' || typeof body.capacity !== 'number') {
    return c.json({ error: '枠の内容を確認してください' }, 400);
  }
  try {
    const slot = await createEmergencySlot(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      pharmacistStaffId: body.pharmacistStaffId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      capacity: body.capacity,
      staffId: scope.staff.id,
    });
    return c.json({ slot }, 201);
  } catch {
    return c.json({ error: '販売対応枠を作成できませんでした' }, 400);
  }
});

emergencyContraceptionRoutes.post('/api/custom/pharmacy/emergency-contraception/slots/:id/cancel', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedVersion !== 'number') return c.json({ error: 'Invalid version' }, 400);
  try {
    await cancelEmergencySlot(c.env.DB, scope.lineAccountId, c.req.param('id'), body.expectedVersion);
    return c.body(null, 204);
  } catch {
    return c.json({ error: '枠を取消できませんでした。受付済み案件を確認してください' }, 409);
  }
});

emergencyContraceptionRoutes.put('/api/custom/pharmacy/emergency-contraception/inventory', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.productCode !== 'string' || typeof body.onHand !== 'number' ||
      typeof body.expectedVersion !== 'number') return c.json({ error: '在庫数を確認してください' }, 400);
  try {
    await setEmergencyInventory(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      productCode: body.productCode,
      onHand: body.onHand,
      expectedVersion: body.expectedVersion,
      staffId: scope.staff.id,
    });
    return c.body(null, 204);
  } catch {
    return c.json({ error: '在庫を更新できませんでした。最新の状態を確認してください' }, 409);
  }
});

emergencyContraceptionRoutes.get('/api/custom/pharmacy/emergency-contraception/intakes', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!c.env.PHARMACY_PHI_KEY_V1) return c.json({ error: 'Service unavailable' }, 503);
  try {
    return c.json({ intakes: await listAdminEmergencyIntakes(
      c.env.DB, scope.lineAccountId, scope.staff.id, c.env.PHARMACY_PHI_KEY_V1,
    ) });
  } catch (error) {
    return c.json({ error: error instanceof Error && /trained pharmacist/.test(error.message)
      ? 'Forbidden' : 'Service unavailable' }, /trained pharmacist/.test(String(error)) ? 403 : 503);
  }
});

const STAFF_TRANSITIONS = new Set(['reviewed', 'completed', 'cancelled', 'expired']);

emergencyContraceptionRoutes.post('/api/custom/pharmacy/emergency-contraception/intakes/:id/transitions', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  const body = await readJsonObject(c.req);
  if (!body || typeof body.status !== 'string' || !STAFF_TRANSITIONS.has(body.status) ||
      typeof body.expectedVersion !== 'number') {
    return c.json({ error: '状態を確認してください' }, 400);
  }
  try {
    const intake = await transitionEmergencyIntake(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      intakeId: c.req.param('id'),
      expectedVersion: body.expectedVersion,
      toStatus: body.status as 'reviewed' | 'completed' | 'cancelled' | 'expired',
      staffId: scope.staff.id,
    });
    return c.json({ intake });
  } catch (error) {
    const status = /trained pharmacist/.test(String(error)) ? 403 : /not found/.test(String(error)) ? 404 : 409;
    return c.json({ error: status === 403 ? 'Forbidden' : '状態が更新されました。再読み込みしてください' }, status);
  }
});
