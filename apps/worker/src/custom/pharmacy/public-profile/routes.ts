import { Hono } from 'hono';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { readJsonObject } from '../json.js';
import { resolvePrescriptionPatient } from '../prescriptions/patient.js';
import { getPharmacyPublicProfile, savePharmacyPublicProfile } from './repository.js';

type PublicProfileEnv = {
  Bindings: Env['Bindings'];
  Variables: Env['Variables'] & { publicProfileLineAccountId: string };
};

export const pharmacyPublicProfileRoutes = new Hono<PublicProfileEnv>();

pharmacyPublicProfileRoutes.use('/api/liff/pharmacy/public-profile', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('publicProfileLineAccountId', patient.lineAccountId);
  return next();
});

pharmacyPublicProfileRoutes.get('/api/liff/pharmacy/public-profile', async (c) => {
  const profile = await getPharmacyPublicProfile(c.env.DB, c.get('publicProfileLineAccountId'));
  return profile ? c.json({ profile: {
    display_name: profile.display_name,
    phone: profile.phone,
    postal_code: profile.postal_code,
    address: profile.address,
    business_hours: profile.business_hours,
    closure_notice: profile.closure_notice,
    access_note: profile.access_note,
    parking_note: profile.parking_note,
    google_maps_url: profile.google_maps_url,
  } }) : c.json({ error: 'Pharmacy account not found' }, 404);
});

pharmacyPublicProfileRoutes.get('/api/custom/pharmacy/public-profile', async (c) => {
  const lineAccountId = c.get('pharmacyLineAccountId');
  if (!lineAccountId || !c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ profile: await getPharmacyPublicProfile(c.env.DB, lineAccountId) });
});

pharmacyPublicProfileRoutes.put('/api/custom/pharmacy/public-profile', async (c) => {
  const lineAccountId = c.get('pharmacyLineAccountId');
  const staff = c.get('staff');
  if (!lineAccountId || !staff) return c.json({ error: 'Unauthorized' }, 401);
  if (staff.role !== 'owner' && staff.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: '入力内容を確認してください' }, 400);
  try {
    await savePharmacyPublicProfile(c.env.DB, {
      lineAccountId,
      staffId: staff.id,
      displayName: String(body.displayName ?? ''),
      phone: String(body.phone ?? ''),
      postalCode: String(body.postalCode ?? ''),
      address: String(body.address ?? ''),
      businessHours: String(body.businessHours ?? ''),
      closureNotice: String(body.closureNotice ?? ''),
      accessNote: String(body.accessNote ?? ''),
      parkingNote: String(body.parkingNote ?? ''),
      googleMapsUrl: String(body.googleMapsUrl ?? ''),
    });
    return c.body(null, 204);
  } catch {
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
});
