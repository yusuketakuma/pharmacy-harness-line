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
  getAdminEmergencyIntakeDetail,
  getEmergencyAdminConfig,
  getEmergencyServiceOverview,
  getEmergencySaleRecord,
  listAdminEmergencyIntakes,
  listCounterConfirmations,
  listOwnerEmergencyIntakes,
  recordEmergencySale,
  saveEmergencySettings,
  setEmergencyInventory,
  setEmergencyPharmacist,
  transitionEmergencyIntake,
  upsertCounterConfirmation,
  type EmergencyCounterSection,
  type EmergencySafeContactMode,
} from './repository.js';
import { validMenstruationSignals, type EmergencyMenstruationSignals } from './policy.js';
import { getEmergencyReminderControl, saveEmergencyReminderControl } from './reminders.js';

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
  return c.json({ service, intakes, server_now: new Date().toISOString() }, 200, {
    'Cache-Control': 'no-store',
  });
});

emergencyContraceptionRoutes.post('/api/liff/pharmacy/emergency-contraception/intakes', async (c) => {
  if (!c.env.PHARMACY_PHI_KEY_V1) {
    return c.json({ error: '現在この受付を利用できません' }, 503);
  }
  const body = await readJsonObject(c.req);
  const signalsBody = body?.menstruationSignals;
  const MENSTRUATION_SIGNAL_KEYS = [
    'noneApply', 'unknown', 'overOneMonthNoPeriod',
    'notRecoveredAfterBirth', 'lastPeriodDifferent', 'earlierConcernOver3Weeks',
  ] as const;
  const validSignalsShape = signalsBody === undefined || (
    signalsBody !== null && typeof signalsBody === 'object' &&
    MENSTRUATION_SIGNAL_KEYS.every((key) => typeof (signalsBody as Record<string, unknown>)[key] === 'boolean')
  );
  if (!body || typeof body.slotId !== 'string' || typeof body.intercourseAt !== 'string' ||
      typeof body.intercourseTimeUnknown !== 'boolean' || typeof body.age !== 'number' ||
      typeof body.recentPurchaseCount !== 'number' || typeof body.patientWillVisit !== 'boolean' ||
      typeof body.acceptsInPersonDose !== 'boolean' || typeof body.safeContactMode !== 'string' ||
      typeof body.consentVersion !== 'string' ||
      typeof body.consentContentHash !== 'string' ||
      typeof body.manufacturerCheckAcknowledged !== 'boolean' ||
      typeof body.idempotencyKey !== 'string' ||
      // A3/A4/A5/A' and B1-B4: optional, but if present must be boolean (default false when absent).
      (body.lngAllergy !== undefined && typeof body.lngAllergy !== 'boolean') ||
      (body.liverDisease !== undefined && typeof body.liverDisease !== 'boolean') ||
      (body.currentlyPregnant !== undefined && typeof body.currentlyPregnant !== 'boolean') ||
      (body.breastfeeding !== undefined && typeof body.breastfeeding !== 'boolean') ||
      (body.underMedicalTreatment !== undefined && typeof body.underMedicalTreatment !== 'boolean') ||
      (body.drugAllergyHistory !== undefined && typeof body.drugAllergyHistory !== 'boolean') ||
      (body.heartKidneyGiDisease !== undefined && typeof body.heartKidneyGiDisease !== 'boolean') ||
      (body.stJohnsWort !== undefined && typeof body.stJohnsWort !== 'boolean') ||
      // C1: optional, string (YYYY-MM-DD) or null (defaults to null = 不明).
      (body.lastMenstruationDate !== undefined && body.lastMenstruationDate !== null &&
       typeof body.lastMenstruationDate !== 'string') ||
      // C2: optional, all 6 signal keys must be boolean when present.
      !validSignalsShape ||
      // D3: optional, boolean or null (未定).
      (body.idDocumentAvailable !== undefined && body.idDocumentAvailable !== null &&
       typeof body.idDocumentAvailable !== 'boolean')) {
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
  const menstruationSignals: EmergencyMenstruationSignals = signalsBody
    ? signalsBody as EmergencyMenstruationSignals
    : {
      noneApply: false, unknown: false, overOneMonthNoPeriod: false,
      notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
    };
  if (!validMenstruationSignals(menstruationSignals)) {
    return c.json({ error: '当てはまるものはない・わからない・具体的な項目のいずれかのみ選んでください' }, 400);
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
      consentContentHash: body.consentContentHash,
      manufacturerCheckAcknowledged: body.manufacturerCheckAcknowledged,
      idempotencyKey: body.idempotencyKey,
      encryptionSecret: c.env.PHARMACY_PHI_KEY_V1,
      // A3/A4/A5/A' and B1-B4: optional booleans, default false so existing LIFF
      // clients that predate this form revision keep working unchanged.
      lngAllergy: body.lngAllergy === true,
      liverDisease: body.liverDisease === true,
      currentlyPregnant: body.currentlyPregnant === true,
      breastfeeding: body.breastfeeding === true,
      underMedicalTreatment: body.underMedicalTreatment === true,
      drugAllergyHistory: body.drugAllergyHistory === true,
      heartKidneyGiDisease: body.heartKidneyGiDisease === true,
      stJohnsWort: body.stJohnsWort === true,
      lastMenstruationDate: (body.lastMenstruationDate as string | null | undefined) ?? null,
      menstruationSignals,
      idDocumentAvailable: (body.idDocumentAvailable as boolean | null | undefined) ?? null,
    });
    return c.json({ intake }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'FEATURE_DISABLED') {
      return c.json({ error: 'この受付は現在利用できません', code: 'FEATURE_DISABLED' }, 409);
    }
    if (message === 'EMERGENCY_CONSENT_VERSION_MISMATCH' || message === 'EMERGENCY_CONSENT_HASH_MISMATCH') {
      return c.json({ error: '同意内容が更新されています。最新の内容をご確認のうえ再度送信してください', code: message }, 409);
    }
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

emergencyContraceptionRoutes.get('/api/custom/pharmacy/emergency-contraception/reminders', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  return c.json(await getEmergencyReminderControl(c.env.DB, scope.lineAccountId));
});

emergencyContraceptionRoutes.put('/api/custom/pharmacy/emergency-contraception/reminders', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!ownerOrAdmin(scope.staff.role)) return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body || !['inactive', 'active', 'frozen'].includes(String(body.state)) ||
      !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return c.json({ error: 'Invalid reminder control' }, 400);
  }
  try {
    return c.json(await saveEmergencyReminderControl(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      staffId: scope.staff.id,
      state: body.state as 'inactive' | 'active' | 'frozen',
      expectedRevision: Number(body.expectedRevision),
    }));
  } catch (error) {
    if (String(error).includes('stale emergency reminder revision')) {
      return c.json({ error: 'Reminder control was updated by another staff member' }, 409);
    }
    return c.json({ error: 'Reminder control could not be updated' }, 400);
  }
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
  } catch (error) {
    if (error instanceof Error && error.message === 'EMERGENCY_CONSENT_VERSION_STALE') {
      return c.json({ error: '同意文言または保存期間を変更する場合は、同意バージョンを更新してください', code: 'EMERGENCY_CONSENT_VERSION_STALE' }, 409);
    }
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
  const status = c.req.query('status');
  if (status !== undefined && !['provisional', 'reviewed', 'completed', 'cancelled', 'expired'].includes(status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const slotId = c.req.query('slotId');
  if (slotId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(slotId)) {
    return c.json({ error: 'Invalid slot' }, 400);
  }
  const deadlineBefore = c.req.query('deadlineBefore');
  if (deadlineBefore !== undefined &&
      (deadlineBefore.length > 40 || !Number.isFinite(Date.parse(deadlineBefore)))) {
    return c.json({ error: 'Invalid deadline' }, 400);
  }
  const limit = c.req.query('limit') === undefined ? 50 : Number(c.req.query('limit'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: 'Invalid limit' }, 400);
  try {
    return c.json(await listAdminEmergencyIntakes(c.env.DB, scope.lineAccountId, {
      status: status as never, slotId, deadlineBefore, cursor: c.req.query('cursor'), limit,
    }));
  } catch (error) {
    return error instanceof Error && error.message === 'invalid emergency intake cursor'
      ? c.json({ error: 'Invalid cursor' }, 400)
      : c.json({ error: 'Service unavailable' }, 503);
  }
});

emergencyContraceptionRoutes.get('/api/custom/pharmacy/emergency-contraception/intakes/:id', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!c.env.PHARMACY_PHI_KEY_V1) return c.json({ error: 'Service unavailable' }, 503);
  try {
    return c.json({ intake: await getAdminEmergencyIntakeDetail(
      c.env.DB, scope.lineAccountId, c.req.param('id'), scope.staff.id, c.env.PHARMACY_PHI_KEY_V1,
    ) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/trained pharmacist/.test(message)) return c.json({ error: 'Forbidden' }, 403);
    if (/not found/.test(message)) return c.json({ error: 'Not found' }, 404);
    return c.json({ error: 'Service unavailable' }, 503);
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

const COUNTER_SECTIONS = new Set(['A', 'B', 'C', 'D']);

emergencyContraceptionRoutes.get(
  '/api/custom/pharmacy/emergency-contraception/intakes/:id/counter-confirmations/:section',
  async (c) => {
    const scope = staffScope(c);
    if (scope instanceof Response) return scope;
    const section = c.req.param('section');
    if (!COUNTER_SECTIONS.has(section)) return c.json({ error: 'Invalid section' }, 400);
    try {
      const confirmations = await listCounterConfirmations(c.env.DB, scope.lineAccountId, c.req.param('id'));
      const confirmation = confirmations.find((item) => item.section === section) ?? null;
      return c.json({ confirmation });
    } catch {
      return c.json({ error: 'Service unavailable' }, 503);
    }
  },
);

emergencyContraceptionRoutes.put(
  '/api/custom/pharmacy/emergency-contraception/intakes/:id/counter-confirmations/:section',
  async (c) => {
    const scope = staffScope(c);
    if (scope instanceof Response) return scope;
    const section = c.req.param('section');
    const body = await readJsonObject(c.req);
    if (!COUNTER_SECTIONS.has(section) || !body || typeof body.checklistVersion !== 'string' ||
        !Array.isArray(body.mismatchItems) || body.mismatchItems.some((item: unknown) => typeof item !== 'string')) {
      return c.json({ error: '入力内容を確認してください' }, 400);
    }
    try {
      const confirmation = await upsertCounterConfirmation(c.env.DB, {
        lineAccountId: scope.lineAccountId,
        intakeId: c.req.param('id'),
        section: section as EmergencyCounterSection,
        checklistVersion: body.checklistVersion,
        mismatchItems: body.mismatchItems as string[],
        staffId: scope.staff.id,
      });
      return c.json({ confirmation });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/trained pharmacist/.test(message)) return c.json({ error: 'Forbidden' }, 403);
      if (/not found/.test(message)) return c.json({ error: 'Not found' }, 404);
      return c.json({ error: '対面確認を記録できませんでした' }, 409);
    }
  },
);

emergencyContraceptionRoutes.post('/api/custom/pharmacy/emergency-contraception/intakes/:id/sale', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!c.env.PHARMACY_PHI_KEY_V1) return c.json({ error: 'Service unavailable' }, 503);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedVersion !== 'number' ||
      (body.outcome !== 'sold' && body.outcome !== 'refused') ||
      typeof body.identityCheck !== 'string' || typeof body.inPersonDose !== 'string' ||
      typeof body.checklistSheetsReceived !== 'number' || typeof body.pregnancyTest !== 'string' ||
      (body.refusalReasonCode !== null && body.refusalReasonCode !== undefined &&
       typeof body.refusalReasonCode !== 'string') ||
      typeof body.referral !== 'string' || !Array.isArray(body.explained) ||
      body.explained.some((item: unknown) => typeof item !== 'string')) {
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
  try {
    const sale = await recordEmergencySale(c.env.DB, {
      lineAccountId: scope.lineAccountId,
      intakeId: c.req.param('id'),
      staffId: scope.staff.id,
      expectedVersion: body.expectedVersion,
      outcome: body.outcome,
      identityCheck: body.identityCheck as never,
      inPersonDose: body.inPersonDose as never,
      checklistSheetsReceived: body.checklistSheetsReceived,
      pregnancyTest: body.pregnancyTest as never,
      refusalReasonCode: (body.refusalReasonCode as string | null | undefined) ?? null,
      referral: body.referral as never,
      explained: body.explained as string[],
      encryptionSecret: c.env.PHARMACY_PHI_KEY_V1,
    });
    return c.json({ sale }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/trained pharmacist/.test(message)) return c.json({ error: 'Forbidden' }, 403);
    if (/not found/.test(message)) return c.json({ error: 'Not found' }, 404);
    if (/invalid sale record/.test(message)) return c.json({ error: '入力内容を確認してください' }, 400);
    return c.json({ error: '販売記録を保存できませんでした。状態を確認してください' }, 409);
  }
});

emergencyContraceptionRoutes.get('/api/custom/pharmacy/emergency-contraception/intakes/:id/sale', async (c) => {
  const scope = staffScope(c);
  if (scope instanceof Response) return scope;
  if (!c.env.PHARMACY_PHI_KEY_V1) return c.json({ error: 'Service unavailable' }, 503);
  try {
    const sale = await getEmergencySaleRecord(
      c.env.DB, scope.lineAccountId, c.req.param('id'), scope.staff.id, c.env.PHARMACY_PHI_KEY_V1,
    );
    return c.json({ sale });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/trained pharmacist/.test(message)) return c.json({ error: 'Forbidden' }, 403);
    if (/not found/.test(message)) return c.json({ error: 'Not found' }, 404);
    return c.json({ error: 'Service unavailable' }, 503);
  }
});
