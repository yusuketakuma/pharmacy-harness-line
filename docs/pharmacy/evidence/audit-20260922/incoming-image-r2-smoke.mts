import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fetchAndStoreIncomingImage } from '../../../../apps/worker/src/services/incoming-image.js';
import { putR2RetentionTombstone, isR2RetentionTombstone } from '../../../../apps/worker/src/services/immutable-r2.js';

const require = createRequire(join(realpathSync('apps/worker/node_modules/wrangler'), 'package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, modules: true, script: 'export default { fetch() { return new Response("local-only"); } };',
  compatibilityDate: '2024-12-01', r2Buckets: ['IMAGES'],
  outboundService: () => { throw new Error('Unexpected external request'); },
}));
try {
  const r2 = await mf.getR2Bucket('IMAGES');
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  };
  const options = { r2, fetch: fetcher, workerUrl: 'https://synthetic.invalid',
    channelAccessToken: 'synthetic', tenantId: 'tenant-a', accountId: 'account-a', messageId: 'message-a' };
  const first = await fetchAndStoreIncomingImage(options);
  assert.ok(first);
  const firstObject = await r2.get(first.r2Key);
  assert.deepEqual(new Uint8Array(await firstObject.arrayBuffer()), bytes);
  const replay = await fetchAndStoreIncomingImage(options);
  assert.deepEqual(replay, first);
  const beforeDelete = await r2.head(first.r2Key);
  assert.equal(await putR2RetentionTombstone(r2, first.r2Key, 'wrong-etag'), false);
  assert.equal((await r2.head(first.r2Key)).size, bytes.length);
  assert.equal(await putR2RetentionTombstone(r2, first.r2Key, beforeDelete.etag), true);
  const tombstone = await r2.head(first.r2Key);
  assert.equal(isR2RetentionTombstone(tombstone), true);
  assert.equal(tombstone.size, 0);
  assert.equal(await fetchAndStoreIncomingImage(options), null);
  const afterReplay = await r2.head(first.r2Key);
  assert.equal(isR2RetentionTombstone(afterReplay), true);
  assert.equal(afterReplay.size, 0);
  assert.equal(afterReplay.etag, tombstone.etag);
  const otherAccount = await fetchAndStoreIncomingImage({ ...options, accountId: 'account-b' });
  assert.ok(otherAccount);
  assert.notEqual(otherAccount.r2Key, first.r2Key);
  assert.equal((await r2.head(otherAccount.r2Key)).size, bytes.length);
  console.log(JSON.stringify({ result: 'PASS', engine: 'local Miniflare R2', fetches,
    idempotentReplay: true, wrongEtagPreservesBytes: true, tombstonePreventsResurrection: true,
    accountKeysDistinct: true }));
} finally { await mf.dispose(); }
