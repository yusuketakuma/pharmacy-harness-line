import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
 resolve:{alias:{'@line-crm/db':resolve('packages/db/src/index.ts'),'@line-crm/line-sdk':resolve('packages/line-sdk/src/index.ts')}},
 test:{environment:'node',include:['docs/pharmacy/evidence/audit-20260922/conversation-time-investigation.test.ts']}
});
