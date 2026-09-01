import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(
  fileURLToPath(new URL('../../../index.ts', import.meta.url).href),
  'utf8',
);

describe('patient timeline composition boundary', () => {
  it('mounts the pharmacy-owned route in the Worker composition root', () => {
    expect(indexSource).toContain(
      "import { patientTimelineRoutes } from './custom/pharmacy/patient-timeline/routes.js'; // custom:pharmacy-patient-timeline",
    );
    expect(indexSource).toContain(
      "app.route('/', patientTimelineRoutes); // custom:pharmacy-patient-timeline",
    );
  });
});
