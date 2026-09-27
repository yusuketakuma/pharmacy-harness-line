import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, cp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = process.cwd();
const evidence = join(root, 'docs/pharmacy/evidence/audit-20260922');
const pkg = join(root, 'packages/plugin-template');
const req = createRequire(join(pkg, 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const temp = await mkdtemp(join(evidence, '.F29-artifact-'));
const env = { LINE_HARNESS_API_URL: 'https://synthetic.invalid', LINE_HARNESS_API_KEY: 'synthetic', LINE_HARNESS_TENANT_ID: 'synthetic-tenant', EXTERNAL_API_KEY: 'synthetic' };
const sentinel = 'PHI_729';
const result = { files: {}, outbound: 0 };
const realLog = console.log, realError = console.error, realFetch = globalThis.fetch;
let client;
try {
  await cp(join(pkg, 'dist'), join(temp, 'dist'), { recursive: true });
  await cp(join(pkg, 'dist-mcp'), join(temp, 'dist-mcp'), { recursive: true });
  await writeFile(join(temp, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(pkg, 'node_modules'), join(temp, 'node_modules'), 'dir');
  for (const file of ['dist/index.js', 'dist-mcp/index.js']) {
    const body = await readFile(join(temp, file));
    result.files[file] = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  }
  globalThis.fetch = async () => { result.outbound++; throw new Error('unexpected external call'); };
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const worker = (await import(pathToFileURL(join(temp, 'dist/index.js')).href)).default;
  for (const [body, status] of [[JSON.stringify({ privateData: sentinel }), 200], [sentinel, 400]]) {
    const response = await worker.fetch(new Request('https://synthetic.invalid/webhook', { method: 'POST', body }), env, {});
    assert.equal(response.status, status);
    assert(!JSON.stringify(await response.json()).includes(sentinel));
  }
  assert.equal((await worker.fetch(new Request('https://synthetic.invalid/health'), env, {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://synthetic.invalid/missing'), env, {})).status, 404);
  assert(!logs.join(' ').includes(sentinel));
  assert.equal(result.outbound, 0);
  console.log = realLog; console.error = realError; globalThis.fetch = realFetch;
  const preload = join(temp, 'synthetic-fetch.mjs');
  await writeFile(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(sentinel)}, {status:503});`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, join(temp, 'dist-mcp/index.js')], env: { ...env, PATH: process.env.PATH, LANG: 'C.UTF-8' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += String(data); });
  client = new Client({ name: 'synthetic-audit', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'lookup_customer'));
  const response = await client.callTool({ name: 'lookup_customer', arguments: { customerId: 'synthetic' } });
  assert(JSON.stringify(response).includes('503'));
  assert(!JSON.stringify(response).includes(sentinel));
  assert(!stderr.includes(sentinel));
  result.worker = 'PASS webhook valid/invalid, health, 404, no private-body log';
  result.mcp = 'PASS compiled stdio tools/list + lookup_customer synthetic HTTP503, no private-body response';
  result.exit = 0;
} finally {
  console.log = realLog; console.error = realError; globalThis.fetch = realFetch;
  if (client) await client.close();
  await rm(temp, { recursive: true, force: true });
}
await writeFile(join(evidence, 'F29-artifact.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
