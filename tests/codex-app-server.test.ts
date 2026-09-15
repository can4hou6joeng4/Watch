import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexImportRpc, type RpcProfile } from '../src/providers/codex/app-server.js';

function fake(t: TestContext, behavior: string, timeout = 500, profile: RpcProfile = 'import') {
  const child = spawn(process.execPath, ['-e', `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const send = (value) => console.log(JSON.stringify(value));
    rl.on('line', (line) => { const message = JSON.parse(line); ${behavior} });
  `], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const rpc = new CodexImportRpc(child, timeout, profile);
  t.after(() => rpc.close());
  return rpc;
}

test('RPC accepts asynchronous completion before acknowledgement and correlates import ID', async (t) => {
  const rpc = fake(t, `
    if (message.method === 'externalAgentConfig/import') {
      send({ method: 'externalAgentConfig/import/completed', params: { importId: 'other', itemTypeResults: [] } });
      send({ method: 'externalAgentConfig/import/completed', params: { importId: 'wanted', itemTypeResults: [1] } });
      send({ id: message.id, result: { importId: 'wanted' } });
    } else if (message.id) send({ id: message.id, result: {} });
  `);
  await rpc.initialize();
  await rpc.request('externalAgentConfig/import', {});
  assert.deepEqual(await rpc.completion('wanted'), { importId: 'wanted', itemTypeResults: [1] });
});

test('RPC handles delayed completion and refuses prompts or configuration writes', async (t) => {
  const rpc = fake(t, `
    send({ id: message.id, result: { importId: 'later' } });
    setTimeout(() => send({ method: 'externalAgentConfig/import/completed', params: { importId: 'later', itemTypeResults: [] } }), 20);
  `);
  await rpc.request('externalAgentConfig/import', {});
  assert.deepEqual(await rpc.completion('later'), { importId: 'later', itemTypeResults: [] });
  await assert.rejects(rpc.request('turn/start', {}), /not allowed/);
  await assert.rejects(rpc.request('config/value/write', {}), /not allowed/);
});

test('RPC rejects server approval requests instead of granting permissions', async (t) => {
  const rpc = fake(t, `
    if (message.method === 'thread/read') {
      global.requestId = message.id;
      send({ method: 'item/permissions/requestApproval', id: 'approval', params: {} });
    } else if (message.id === 'approval') {
      send({ id: global.requestId, result: { denied: message.error.code === -32601 } });
    }
  `);
  assert.deepEqual(await rpc.request('thread/read', {}), { denied: true });
});

test('RPC bounds waiting for completion without retrying an import', async (t) => {
  const rpc = fake(t, `send({ id: message.id, result: {} });`, 100);
  await rpc.request('externalAgentConfig/import', {});
  await assert.rejects(rpc.completion('missing'), /timed out/);
});

test('RPC rejects malformed output and process exit with generic diagnostics', async (t) => {
  for (const behavior of [`console.log('not JSON');`, `process.exit(1);`]) {
    const rpc = fake(t, behavior);
    await assert.rejects(rpc.request('thread/read', {}), /Invalid|closed/);
  }
});

test('RPC does not expose server error text', async (t) => {
  const rpc = fake(t, `send({ id: message.id, error: { message: 'private native diagnostics' } });`);
  await assert.rejects(rpc.request('thread/read', {}), (error: Error) => !error.message.includes('private'));
});

test('project RPC profile cannot import sessions, create projects, change settings, or invoke models', async (t) => {
  const rpc = fake(t, `send({id:message.id,result:{}});`, 500, 'project-binding');
  await rpc.request('project/read', {});
  await rpc.request('thread/metadata/update', {});
  for (const method of ['externalAgentConfig/import', 'project/create', 'project/delete', 'config/value/write', 'turn/start']) {
    await assert.rejects(rpc.request(method, {}), /not allowed/);
  }
  const importer = fake(t, '', 500);
  await assert.rejects(importer.request('thread/metadata/update', {}), /not allowed/);
});

test('desktop import profile permits only import and membership verification methods', async (t) => {
  const rpc = fake(t, `send({id:message.id,result:{}});`, 500, 'desktop-import');
  for (const method of [
    'externalAgentConfig/detect', 'externalAgentConfig/import', 'project/read',
    'thread/read', 'thread/list', 'thread/metadata/update',
  ]) await rpc.request(method, {});
  for (const method of ['project/create', 'project/delete', 'config/value/write', 'turn/start']) {
    await assert.rejects(rpc.request(method, {}), /not allowed/);
  }
});
