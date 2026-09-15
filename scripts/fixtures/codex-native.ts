import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseClaudeSession } from '../../src/providers/claude/parse.js';
import { encodeClaudeProjectDir } from '../../src/providers/claude/build.js';
import { importTurnsToCodex } from '../../src/providers/codex/build.js';

const root = process.env.WATCH_VALIDATION_ROOT;
assert.ok(root && path.isAbsolute(root), 'Run through validate-codex-native.mjs');
assert.equal(homedir(), path.join(root, 'home'), 'Refuse a non-isolated HOME');
const cwd = path.join(root, 'project with spaces');
await mkdir(cwd, { recursive: true });
const sourceId = randomUUID();
const sourceDir = path.join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd));
await mkdir(sourceDir, { recursive: true });
const sourcePath = path.join(sourceDir, `${sourceId}.jsonl`);
const marker = 'WATCH_NATIVE_PROBE_20260907';
const resultMarker = 'WATCH_TOOL_RESULT_ONLY_' + 'x'.repeat(512);
const argumentMarker = 'tool-argument-only.txt';
await writeFile(path.join(cwd, argumentMarker), resultMarker + '\n', { mode: 0o600 });
const records = [
  { type: 'user', message: { role: 'user', content: `Remember ${marker}. The test task is to inspect sample.txt.` } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'watch-probe-read', name: 'Read', input: { file_path: argumentMarker } },
  ] } },
  { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'watch-probe-read', content: resultMarker },
  ] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: `The file contains ${marker}. No code was changed.` },
  ] } },
].map((record, i) => ({
  ...record, cwd, sessionId: sourceId, uuid: `watch-probe-${i}`,
  parentUuid: i ? `watch-probe-${i - 1}` : null,
  timestamp: new Date(Date.UTC(2026, 8, 7, 0, 0, i)).toISOString(),
}));
await writeFile(sourcePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceBefore = digest(await readFile(sourcePath, 'utf8'));
const turns = await parseClaudeSession({ provider: 'claude', sessionId: sourceId, filePath: sourcePath, cwd });
assert.ok(turns.some((turn) => turn.role === 'user' && turn.text.includes(marker)));
assert.ok(turns.some((turn) => turn.events?.some((event) => event.kind === 'tool_call')));
const sourceOnly = process.env.WATCH_VALIDATION_SOURCE_ONLY === '1';
const target = sourceOnly
  ? { provider: 'codex', sessionId: '', filePath: '', cwd }
  : await importTurnsToCodex(turns, cwd);
assert.equal(digest(await readFile(sourcePath, 'utf8')), sourceBefore);
console.log(JSON.stringify({ target, marker, argumentMarker, resultMarker, sourceId, sourcePath, sourceDigest: sourceBefore, sourceUnchanged: true, expectedTurns: turns.length, sourceOnly }));
