import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps LIFF integration to one marked import and route', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  expect(source).toContain(
    "import PrescriptionPage from './custom/pharmacy/prescriptions/PrescriptionPage.js'; // custom:pharmacy-prescriptions",
  );
  expect(source).toContain(
    '<Route path="/prescriptions" element={<PrescriptionPage />} /> {/* custom:pharmacy-prescriptions */}',
  );
});
