import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const directory = process.argv[2];
const calls = [];
let status = 'absent';
let scenario = null;
const server = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  assert.equal(req.headers['x-tenant-id'], 'synthetic-tenant');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.resume();
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api/broadcasts') {
      status = 'draft';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { id: 'synthetic-broadcast', status } }));
    } else if (req.method === 'POST' && req.url.endsWith('/send-segment')) {
      status = 'sending';
      res.destroy(); // Accepted queue write, then lost HTTP response.
    } else if (req.method === 'POST' && req.url === '/api/scenarios') {
      assert.equal(JSON.parse(body).isActive, false);
      scenario = { id: 'synthetic-scenario', isActive: false, steps: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: scenario }));
    } else if (req.method === 'POST' && req.url === '/api/scenarios/synthetic-scenario/steps') {
      scenario.steps.push(JSON.parse(body));
      if (scenario.steps.length === 2) res.destroy();
      else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: 'step-one' } })); }
    } else { res.statusCode = 500; res.end('{}'); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, [`${directory}/dist/index.js`], {
  cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, LINE_HARNESS_API_URL: `http://127.0.0.1:${server.address().port}`,
    LINE_HARNESS_API_KEY: 'synthetic-key', LINE_HARNESS_TENANT_ID: 'synthetic-tenant' },
});
let buffer = '', stderr = '', sequence = 0;
const pending = new Map();
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  }
});
const rpc = async (method, params) => {
  const id = ++sequence;
  let timer;
  try {
    return await Promise.race([
      new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP response timeout')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
};
try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-audit', version: '1.0.0' } });
  assert.equal(init.error, undefined);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list', {});
  const tool = listed.result.tools.find(item => item.name === 'broadcast');
  assert.ok(tool);
  const response = await rpc('tools/call', { name: 'broadcast', arguments: {
    title: 'synthetic', messageType: 'text', messageContent: 'synthetic', targetType: 'segment',
    segmentConditions: JSON.stringify({ operator: 'AND', rules: [] }),
  } });
  assert.equal(response.result.isError, true);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.broadcastId, 'synthetic-broadcast');
  assert.equal(result.outcome, 'unknown');
  assert.equal(status, 'sending');
  assert.deepEqual(calls, ['POST /api/broadcasts', 'POST /api/broadcasts/synthetic-broadcast/send-segment']);
  const created = await rpc('tools/call', { name: 'create_scenario', arguments: {
    name: 'synthetic', triggerType: 'friend_add', steps: [
      { delay: '0m', type: 'text', content: 'first' },
      { delay: '30m', type: 'text', content: 'second' },
    ],
  } });
  assert.equal(created.result.isError, true);
  const creationResult = JSON.parse(created.result.content[0].text);
  assert.equal(creationResult.scenarioId, 'synthetic-scenario');
  assert.equal(creationResult.confirmedStepCount, 1);
  assert.equal(creationResult.outcome, 'unknown');
  assert.equal(scenario.isActive, false);
  assert.equal(scenario.steps.length, 2);
  assert.deepEqual(calls.slice(2), ['POST /api/scenarios',
    'POST /api/scenarios/synthetic-scenario/steps', 'POST /api/scenarios/synthetic-scenario/steps']);
  console.log(JSON.stringify({ result: 'PASS', scenarioRetained: scenario,
    scenarioSchema: listed.result.tools.find(item => item.name === 'create_scenario').inputSchema, protocol: init.result.protocolVersion,
    version: init.result.serverInfo.version, toolCount: listed.result.tools.length,
    broadcastSchema: tool.inputSchema, calls, storedStatus: status,
    artifactSha256: createHash('sha256').update(readFileSync(`${directory}/dist/index.js`)).digest('hex') }, null, 2));
} finally {
  child.stdin.end();
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
  await new Promise(resolve => server.close(resolve));
}
