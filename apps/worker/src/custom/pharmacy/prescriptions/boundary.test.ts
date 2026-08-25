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
  expect(source).not.toContain('purgePrescriptionFilesPastRetention');
  const dataProtection = readFileSync(join(
    process.cwd(), 'src', 'custom', 'pharmacy', 'platform-admin', 'data-protection-routes.ts',
  ), 'utf8');
  expect(dataProtection).toContain('purgePrescriptionFilesPastRetention');
  expect(dataProtection).toContain('assertRecoveryExecution');
  expect(source).toContain(
    "import { purgeEmergencyIntakesPastRetention } from './custom/pharmacy/emergency-contraception/retention-purge.js'; // custom:pharmacy-emergency-contraception",
  );
  expect(source).toContain(
    'await purgeEmergencyIntakesPastRetention(env.DB, { // custom:pharmacy-emergency-contraception',
  );
  expect(source).toContain(
    "import { pharmacyIntakeRoutes } from './custom/pharmacy/intake/routes.js'; // custom:pharmacy-intake",
  );
  expect(source).toContain("app.route('/', pharmacyIntakeRoutes); // custom:pharmacy-intake");
  expect(source).toContain(
    "import { fulfillmentRoutes } from './custom/pharmacy/fulfillment/routes.js'; // custom:pharmacy-fulfillment",
  );
  expect(source).toContain("import { continuityRoutes } from './custom/pharmacy/continuity/routes.js'; // custom:pharmacy-continuity");
});
