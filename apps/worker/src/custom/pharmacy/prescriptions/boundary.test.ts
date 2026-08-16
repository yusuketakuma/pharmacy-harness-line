import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps the Worker integration to one marked import and route mount', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  expect(source).toContain(
    "import { prescriptionRoutes } from './custom/pharmacy/prescriptions/routes.js'; // custom:pharmacy-prescriptions",
  );
  expect(source).toContain(
    "app.route('/', prescriptionRoutes); // custom:pharmacy-prescriptions",
  );
  expect(source).toContain(
    "import { retryFailedPrescriptionNotifications } from './custom/pharmacy/prescriptions/notifications.js'; // custom:pharmacy-prescriptions",
  );
  expect(source).toContain(
    'await retryFailedPrescriptionNotifications(env.DB, { // custom:pharmacy-prescriptions',
  );
  expect(source).toContain(
    "import { cleanupPrescriptionImages } from './custom/pharmacy/prescriptions/cleanup.js'; // custom:pharmacy-prescriptions",
  );
  expect(source).toContain(
    'await cleanupPrescriptionImages(env.DB, env.IMAGES, { // custom:pharmacy-prescriptions',
  );
});
