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
});
