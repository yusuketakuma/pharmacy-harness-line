import { Hono } from 'hono';
import {
  BUNDLE_VERSION,
  WORKER_HASH,
  ADMIN_HASH,
  LIFF_HASH,
  WORKER_ASSETS_HASH,
  RELEASED_AT,
} from '../_version.js';

// Unauthenticated by design: build hashes are public release metadata.
const app = new Hono();

app.get('/version', (c) =>
  c.json({
    version: BUNDLE_VERSION,
    worker_hash: WORKER_HASH,
    admin_hash: ADMIN_HASH,
    liff_hash: LIFF_HASH,
    worker_assets_hash: WORKER_ASSETS_HASH,
    released_at: RELEASED_AT,
  }),
);

export default app;
