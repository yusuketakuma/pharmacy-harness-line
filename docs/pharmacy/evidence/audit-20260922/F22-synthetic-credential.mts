import { writeFileSync } from 'node:fs';
import { encryptLineCredential } from '../../../../apps/worker/src/custom/pharmacy/provisioning/line-credentials.ts';
const encrypted = await encryptLineCredential({rootSecret:'synthetic-f22-root-secret-for-isolated-tests',tenantId:'queue-tenant-a',lineAccountId:'queue-account-a',kind:'channel_access_token',credential:'synthetic-f22-access-token-for-isolated-tests'});
writeFileSync(new URL('./F22-synthetic-credential.json',import.meta.url),JSON.stringify(encrypted));
