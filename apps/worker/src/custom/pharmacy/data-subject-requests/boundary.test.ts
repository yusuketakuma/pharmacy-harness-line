import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts'),
  'utf8',
);

describe('data subject request router wiring', () => {
  it('is mounted behind the pharmacy tenant boundary guard', () => {
    expect(workerSource).toContain(
      "import { dataSubjectRequestRoutes } from './custom/pharmacy/data-subject-requests/routes.js'; // custom:pharmacy-data-subject-requests",
    );
    expect(workerSource).toContain(
      "app.route('/', dataSubjectRequestRoutes); // custom:pharmacy-data-subject-requests",
    );
    expect(workerSource).toContain("app.use('/api/custom/pharmacy/*', pharmacyAccountGuard);");
  });
});
