import { Hono, type Context } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { readJsonObject } from '../json.js';
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';
import {
  acknowledgePrescriptionPrintTask,
  claimPrescriptionPrintTask,
  preparePrescriptionPrintTask,
} from './repository.js';

type PrintEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ID?: string };
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
};

export const pharmacyPrintRoutes = new Hono<PrintEnv>();
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,160}$/;

async function authorize(c: Context<PrintEnv>): Promise<string | Response> {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  if (!(await hasPharmacyCapability(c.env.DB, lineAccountId, 'prescription_intake'))) {
    return c.json({ error: 'Prescription intake is not enabled' }, 403);
  }
  return lineAccountId;
}

async function operationId(c: Context<PrintEnv>): Promise<string | null> {
  const body = await readJsonObject(c.req);
  const value = body?.operationId;
  return typeof value === 'string' && OPERATION_ID.test(value) ? value : null;
}

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/submissions/:id/prepare', async (c) => {
  const account = await authorize(c);
  if (account instanceof Response) return account;
  const task = await preparePrescriptionPrintTask(c.env.DB, account, c.req.param('id'));
  return task ? c.json({ task }) : c.json({ error: 'Printable prescription not found' }, 404);
});

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/tasks/:id/claim', async (c) => {
  const account = await authorize(c);
  if (account instanceof Response) return account;
  const id = await operationId(c);
  if (!id) return c.json({ error: 'Invalid operation id' }, 400);
  const task = await claimPrescriptionPrintTask(c.env.DB, account, c.req.param('id'), c.get('staff').id, id);
  return task ? c.json({ task }) : c.json({ error: 'Print task is already in use or stale' }, 409);
});

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/tasks/:id/ack', async (c) => {
  const account = await authorize(c);
  if (account instanceof Response) return account;
  const id = await operationId(c);
  if (!id) return c.json({ error: 'Invalid operation id' }, 400);
  const task = await acknowledgePrescriptionPrintTask(c.env.DB, account, c.req.param('id'), c.get('staff').id, id);
  return task ? c.json({ task }) : c.json({ error: 'Print task is already in use or stale' }, 409);
});
