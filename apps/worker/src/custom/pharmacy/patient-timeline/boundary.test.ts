import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8');

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
