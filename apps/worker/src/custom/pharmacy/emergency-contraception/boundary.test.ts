import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts'),
  'utf8',
);
const envExample = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../../../.env.example'),
  'utf8',
);

describe('emergency contraception integration boundary', () => {
  it('mounts the bounded route group and declares the isolated PHI key', () => {
    expect(workerSource).toContain(
      "import { emergencyContraceptionRoutes } from './custom/pharmacy/emergency-contraception/routes.js'; // custom:pharmacy-emergency-contraception",
    );
    expect(workerSource).toContain(
      "app.route('/', emergencyContraceptionRoutes); // custom:pharmacy-emergency-contraception",
    );
    expect(workerSource).toContain('PHARMACY_PHI_KEY_V1?: string;');
    expect(envExample).toContain('PHARMACY_PHI_KEY_V1=');
  });
});
