import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  inspectOfficialOpenCodeExport,
  normalizeOpenCodeTargetModel,
} from '../src/providers/opencode/official-export.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: npm run validate:opencode-server -- /absolute/path/to/opencode-native-report.json [--output docs/evidence/<new-file>.json]';
const sessionIdPattern = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function record(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function serverOrigin(value) {
  assert.equal(typeof value, 'string', 'The native report must include a manual server origin');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'http:', 'The OpenCode validation server must use HTTP on loopback');
  assert.equal(parsed.hostname, '127.0.0.1', 'The OpenCode validation server must bind exact IPv4 loopback');
  assert.equal(parsed.username, '', 'The OpenCode validation server URL must not contain credentials');
  assert.equal(parsed.password, '', 'The OpenCode validation server URL must not contain credentials');
  assert.equal(parsed.pathname, '/', 'The OpenCode validation server origin cannot contain a path');
  assert.equal(parsed.search, '', 'The OpenCode validation server origin cannot contain a query');
  assert.equal(parsed.hash, '', 'The OpenCode validation server origin cannot contain a fragment');
  const port = Number(parsed.port);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65_535, 'The OpenCode validation server needs an explicit port');
  return parsed.origin;
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.ok, true, `OpenCode server read failed with HTTP ${response.status}`);
  return response.json();
}

export async function resolveOpenCodeServerReportOutput(
  value,
  evidenceDirectory = path.join(repo, 'docs', 'evidence'),
  baseDirectory = repo,
) {
  const output = path.resolve(baseDirectory, value);
  const evidenceRoot = await realpath(evidenceDirectory);
  assert.equal(await realpath(path.dirname(output)), evidenceRoot, 'Server reports must be new JSON files directly under docs/evidence/');
  assert.equal(path.extname(output), '.json', 'Server reports must use a .json extension');
  return output;
}

export async function writeOpenCodeServerReport(output, result) {
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function verifyOpenCodeServerReport(reportFile, fetchImpl = fetch) {
  assert.ok(path.isAbsolute(reportFile), 'The OpenCode native report path must be absolute');
  const reportPath = await realpath(reportFile);
  assert.equal((await lstat(reportPath)).isFile(), true, 'The OpenCode native report must be a regular file');
  const reportText = await readFile(reportPath, 'utf8');
  const reportSha256 = createHash('sha256').update(reportText).digest('hex');
  const report = record(JSON.parse(reportText), 'native report');
  assert.equal(report.route, 'watch-opencode-official-native-probe', 'Unexpected native report route');
  assert.equal(report.acceptance, 'passed', 'The native import must pass before server verification');
  assert.equal(report.isolatedRootRetained, true, 'The native report must retain its isolated root');
  assert.equal(typeof report.isolatedRoot, 'string', 'The native report must include its isolated root');
  assert.equal((await lstat(await realpath(report.isolatedRoot))).isDirectory(), true, 'The isolated root is unavailable');
  assert.equal(typeof report.cwd, 'string', 'The native report must include its cwd');
  assert.ok(path.isAbsolute(report.cwd), 'The native report cwd must be absolute');
  assert.match(report.targetSessionId, sessionIdPattern, 'The native report target session ID is invalid');
  const expectedSummary = record(report.exportSummary, 'native export summary');
  const targetModel = normalizeOpenCodeTargetModel(record(report.targetModel, 'native target model'));
  const manualServer = record(report.manualServer, 'manual server');
  const origin = serverOrigin(manualServer.origin);
  const healthUrl = `${origin}/global/health`;
  const sessionsUrl = `${origin}/session`;
  const sessionUrl = `${origin}/session/${report.targetSessionId}`;
  const messagesUrl = `${sessionUrl}/message`;
  const providerUrl = `${origin}/provider`;
  assert.deepEqual(
    {
      healthUrl: manualServer.healthUrl,
      sessionsUrl: manualServer.sessionsUrl,
      sessionUrl: manualServer.sessionUrl,
      messagesUrl: manualServer.messagesUrl,
      providerUrl: manualServer.providerUrl,
    },
    { healthUrl, sessionsUrl, sessionUrl, messagesUrl, providerUrl },
    'The native report server endpoints do not match its loopback origin and target ID',
  );

  const health = record(await getJson(fetchImpl, healthUrl), 'OpenCode health response');
  assert.equal(health.healthy, true, 'OpenCode server is not healthy');
  assert.equal(health.version, report.cliVersion, 'OpenCode server version differs from the import client');
  const sessions = await getJson(fetchImpl, sessionsUrl);
  assert.ok(Array.isArray(sessions), 'OpenCode session list response must be an array');
  assert.equal(sessions.filter((value) => record(value, 'session list item').id === report.targetSessionId).length, 1,
    'OpenCode server session list must contain the target exactly once');
  const session = record(await getJson(fetchImpl, sessionUrl), 'OpenCode session response');
  assert.equal(session.id, report.targetSessionId, 'OpenCode server returned the wrong session');
  assert.equal(session.directory, report.cwd, 'OpenCode server returned the wrong cwd');
  const messages = await getJson(fetchImpl, messagesUrl);
  assert.ok(Array.isArray(messages), 'OpenCode message response must be an array');
  const summary = inspectOfficialOpenCodeExport({ info: session, messages });
  assert.deepEqual(summary, expectedSummary, 'OpenCode server messages differ from the confirmed native import');
  assert.deepEqual(summary.targetModel, targetModel, 'OpenCode server messages use a different target model');
  const providers = record(await getJson(fetchImpl, providerUrl), 'OpenCode provider response');
  assert.ok(Array.isArray(providers.connected), 'OpenCode provider response must include connected providers');
  assert.equal(providers.connected.filter((value) => value === targetModel.providerID).length, 1,
    'OpenCode target provider is not connected exactly once');
  assert.ok(Array.isArray(providers.all), 'OpenCode provider response must include the provider catalog');
  const matchingProviders = providers.all.filter((value) => record(value, 'provider item').id === targetModel.providerID);
  assert.equal(matchingProviders.length, 1, 'OpenCode provider catalog must contain the target provider exactly once');
  const models = record(record(matchingProviders[0], 'target provider').models, 'target provider models');
  const matchingModels = Object.values(models).filter((value) => {
    const model = record(value, 'target provider model');
    return model.id === targetModel.modelID && model.providerID === targetModel.providerID;
  });
  assert.equal(matchingModels.length, 1, 'OpenCode provider catalog must contain the target model exactly once');
  if (targetModel.variant) {
    const variants = record(record(matchingModels[0], 'target model').variants, 'target model variants');
    assert.ok(Object.hasOwn(variants, targetModel.variant), 'OpenCode target model variant is unavailable');
  }

  return {
    checkedAt: new Date().toISOString(),
    route: 'watch-opencode-server-read-probe',
    acceptance: 'passed',
    nativeReport: reportPath,
    nativeReportSha256: reportSha256,
    origin,
    cliVersion: report.cliVersion,
    cwd: report.cwd,
    targetSessionId: report.targetSessionId,
    targetModel,
    health: 'healthy-version-matched',
    sessionList: 'target-present-once',
    sessionRead: 'target-and-cwd-matched',
    messageRead: 'official-export-summary-matched',
    providerConnection: 'target-provider-connected',
    modelCatalog: 'target-model-present',
    webUi: 'not-run',
    attachedTui: 'not-run',
    modelCalled: false,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  assert.equal(positionals.length, 1, usage);
  assert.ok(path.isAbsolute(positionals[0]), 'The OpenCode native report path must be absolute');
  const output = values.output ? await resolveOpenCodeServerReportOutput(values.output) : null;
  const result = await verifyOpenCodeServerReport(positionals[0]);
  if (output) await writeOpenCodeServerReport(output, result);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
