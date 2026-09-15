import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildOfficialOpenCodeExport, inspectOfficialOpenCodeExport } from '../src/providers/opencode/official-export.js';
import {
  resolveOpenCodeServerReportOutput,
  verifyOpenCodeServerReport,
  writeOpenCodeServerReport,
} from '../scripts/validate-opencode-server.mjs';

const turns = [
  { role: 'user' as const, text: 'Read the server fixture.', timestamp: '2026-09-09T01:00:00.000Z', provider: 'claude' },
  { role: 'assistant' as const, text: 'The server fixture is readable.', timestamp: '2026-09-09T01:00:01.000Z', provider: 'claude' },
];
const targetModel = { providerID: 'opencode', modelID: 'big-pickle' } as const;

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t: TestContext, mutateMessages?: (messages: unknown[]) => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'watch-opencode-server-validator-'));
  const cwd = path.join(root, 'project with spaces');
  await mkdir(cwd, { recursive: true });
  const exported = buildOfficialOpenCodeExport(turns, cwd, {
    seed: 'server-validator-fixture',
    sourceProvider: 'claude',
    version: '1.18.29',
    targetModel,
  });
  const messages = structuredClone(exported.messages);
  mutateMessages?.(messages);
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const body = request.url === '/global/health'
      ? { healthy: true, version: '1.18.29' }
      : request.url === '/session'
        ? [exported.info]
        : request.url === '/provider'
          ? {
              connected: ['opencode'],
              default: { opencode: 'big-pickle' },
              all: [{
                id: 'opencode',
                models: { 'big-pickle': { id: 'big-pickle', providerID: 'opencode', variants: {} } },
              }],
            }
        : request.url === `/session/${exported.info.id}`
          ? exported.info
          : request.url === `/session/${exported.info.id}/message`
            ? messages
            : { error: 'not found' };
    response.statusCode = 'error' in body ? 404 : 200;
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const reportFile = path.join(root, 'native-report.json');
  await writeFile(reportFile, JSON.stringify({
    route: 'watch-opencode-official-native-probe',
    acceptance: 'passed',
    cliVersion: '1.18.29',
    cwd,
    targetSessionId: exported.info.id,
    targetModel,
    exportSummary: inspectOfficialOpenCodeExport(exported),
    isolatedRootRetained: true,
    isolatedRoot: root,
    manualServer: {
      origin,
      healthUrl: `${origin}/global/health`,
      sessionsUrl: `${origin}/session`,
      sessionUrl: `${origin}/session/${exported.info.id}`,
      messagesUrl: `${origin}/session/${exported.info.id}/message`,
      providerUrl: `${origin}/provider`,
    },
  }));
  t.after(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
  });
  return { reportFile, root, origin, exported };
}

test('OpenCode server validator verifies exact imported history through read-only APIs', async (t) => {
  const f = await fixture(t);
  const result = await verifyOpenCodeServerReport(f.reportFile);
  assert.equal(result.acceptance, 'passed');
  assert.equal(result.origin, f.origin);
  assert.equal(result.targetSessionId, f.exported.info.id);
  assert.equal(result.nativeReport, await realpath(f.reportFile));
  assert.equal(result.nativeReportSha256, createHash('sha256').update(await readFile(f.reportFile)).digest('hex'));
  assert.equal(result.messageRead, 'official-export-summary-matched');
  assert.equal(result.providerConnection, 'target-provider-connected');
  assert.equal(result.modelCatalog, 'target-model-present');
  assert.deepEqual(result.targetModel, targetModel);
  assert.equal(result.webUi, 'not-run');
  assert.equal(result.attachedTui, 'not-run');
  assert.equal(result.modelCalled, false);
});

test('OpenCode server validator refuses non-loopback targets before any request', async (t) => {
  const f = await fixture(t);
  const report = JSON.parse(await readFile(f.reportFile, 'utf8'));
  report.manualServer.origin = 'https://example.com:4096';
  await writeFile(f.reportFile, JSON.stringify(report));
  let requested = false;
  await assert.rejects(
    verifyOpenCodeServerReport(f.reportFile, async () => {
      requested = true;
      throw new Error('unexpected fetch');
    }),
    /must use HTTP on loopback/,
  );
  assert.equal(requested, false);
});

test('OpenCode server validator rejects message history that differs from native import', async (t) => {
  const f = await fixture(t, (messages) => { messages.pop(); });
  await assert.rejects(verifyOpenCodeServerReport(f.reportFile), /messages differ/);
});

test('OpenCode server validator writes one private evidence file and refuses path escapes or overwrite', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'watch-opencode-server-output-'));
  const evidence = path.join(root, 'docs', 'evidence');
  await mkdir(evidence, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const output = await resolveOpenCodeServerReportOutput('docs/evidence/server.json', evidence, root);
  const result = { acceptance: 'passed', modelCalled: false };
  await writeOpenCodeServerReport(output, result);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(writeOpenCodeServerReport(output, result), { code: 'EEXIST' });
  await assert.rejects(
    resolveOpenCodeServerReportOutput('outside.json', evidence, root),
    /directly under docs\/evidence/,
  );
  await assert.rejects(
    resolveOpenCodeServerReportOutput('docs/evidence/server.txt', evidence, root),
    /\.json extension/,
  );
});
