import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOfficialOpenCodeExport,
  createOfficialOpenCodeSessionId,
  inspectOfficialOpenCodeExport,
  SUPPORTED_OPENCODE_EXPORT_VERSION,
} from '../src/providers/opencode/official-export.js';
import type { UnifiedTurn } from '../src/core/types.js';

const cwd = '/tmp/watch project with spaces';
const seed = 'source-provider:source-session:source-digest';
const targetModel = { providerID: 'opencode', modelID: 'big-pickle' } as const;

function richTurns(): UnifiedTurn[] {
  return [
    { role: 'user', text: 'Inspect the project', timestamp: '2026-09-08T01:00:00.000Z', provider: 'claude' },
    {
      role: 'assistant',
      text: 'Inspection complete',
      timestamp: '2026-09-08T01:00:01.000Z',
      provider: 'claude',
      usage: { inputTokens: 120, outputTokens: 30 },
      events: [
        { kind: 'thinking', summary: 'reasoning', detail: 'check files first', timestamp: '2026-09-08T01:00:01.100Z', provider: 'claude' },
        { kind: 'tool_call', summary: 'Read', name: 'Read', callId: 'call-1', input: { file_path: '/tmp/a.ts' }, timestamp: '2026-09-08T01:00:01.200Z', provider: 'claude' },
        { kind: 'tool_result', summary: 'source', detail: 'const value = 1;', callId: 'call-1', timestamp: '2026-09-08T01:00:01.300Z', provider: 'claude' },
      ],
    },
  ];
}

test('official OpenCode export uses deterministic fresh native IDs and complete references', () => {
  const first = buildOfficialOpenCodeExport(richTurns(), cwd, { seed, sourceProvider: 'Claude Code', targetModel });
  const second = buildOfficialOpenCodeExport(richTurns(), cwd, { seed, sourceProvider: 'Claude Code', targetModel });
  assert.deepEqual(second, first);
  assert.equal(first.info.version, SUPPORTED_OPENCODE_EXPORT_VERSION);
  assert.match(first.info.id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(first.info.id.includes('source-session'), false);
  assert.equal(first.messages.length, 3);

  const summary = inspectOfficialOpenCodeExport(first);
  assert.deepEqual(
    { users: summary.users, assistants: summary.assistants, messages: summary.messages },
    { users: 1, assistants: 2, messages: 3 },
  );
  assert.equal(summary.partTypes.tool, 1);
  assert.equal(summary.partTypes.reasoning, 1);
  assert.deepEqual(summary.targetModel, targetModel);
  for (const message of first.messages) {
    const actual = message.info.role === 'user'
      ? message.info.model
      : { providerID: message.info.providerID, modelID: message.info.modelID };
    assert.deepEqual(actual, targetModel);
  }
  const tool = first.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool')!;
  assert.deepEqual(tool.state, {
    status: 'completed',
    input: { file_path: '/tmp/a.ts' },
    output: 'const value = 1;',
    title: 'Read',
    metadata: {},
    time: { start: 1788829201200, end: 1788829201301 },
  });
});

test('official OpenCode export preserves attachments and marks interrupted tools as errors', () => {
  const turns: UnifiedTurn[] = [
    {
      role: 'user', text: '', timestamp: '2026-09-08T02:00:00.000Z', provider: 'codex',
      events: [{
        kind: 'text', summary: '[attachment]', timestamp: '2026-09-08T02:00:00.100Z', provider: 'codex',
        attachment: { kind: 'file', mediaType: 'text/plain', data: 'aGVsbG8=', filename: 'note.txt' },
      }],
    },
    {
      role: 'assistant', text: '', timestamp: '2026-09-08T02:00:01.000Z', provider: 'codex',
      events: [{
        kind: 'tool_call', summary: 'Bash', name: 'Bash', callId: 'unfinished', input: { command: 'pwd' },
        timestamp: '2026-09-08T02:00:01.100Z', provider: 'codex',
      }],
    },
  ];
  const value = buildOfficialOpenCodeExport(turns, cwd, {
    seed: `${seed}:attachment`, sourceProvider: 'Codex', targetModel,
  });
  const parts = value.messages.flatMap((message) => message.parts);
  assert.ok(parts.some((part) => part.type === 'file' && part.url === 'data:text/plain;base64,aGVsbG8='));
  const tool = parts.find((part) => part.type === 'tool')!;
  assert.equal((tool.state as { status: string }).status, 'error');
  assert.doesNotThrow(() => inspectOfficialOpenCodeExport(value));
});

test('official OpenCode export rejects unsupported versions, broken references and invalid timelines', () => {
  assert.throws(
    () => buildOfficialOpenCodeExport([{ role: 'assistant', text: 'orphan', timestamp: 'invalid' }], cwd, {
      seed, sourceProvider: 'Claude Code', targetModel,
    }),
    /cannot start with an assistant/,
  );
  const value = buildOfficialOpenCodeExport(richTurns(), cwd, { seed, sourceProvider: 'Claude Code', targetModel });
  value.messages[0]!.parts[0]!.messageID = 'msg_000000000000AAAAAAAAAAAA';
  assert.throws(() => inspectOfficialOpenCodeExport(value), /part reference/);

  const unsupported = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:version`, sourceProvider: 'Claude Code', targetModel,
  });
  unsupported.info.version = '1.18.30';
  assert.throws(() => inspectOfficialOpenCodeExport(unsupported), /Unsupported OpenCode export version/);

  const invalidSessionTime = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:session-time`, sourceProvider: 'Claude Code', targetModel,
  });
  invalidSessionTime.info.time.created = -1;
  assert.throws(() => inspectOfficialOpenCodeExport(invalidSessionTime), /session created time/);

  const invalidUserModel = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:user-model`, sourceProvider: 'Claude Code', targetModel,
  });
  (invalidUserModel.messages[0]!.info.model as Record<string, unknown>).providerID = 42;
  assert.throws(() => inspectOfficialOpenCodeExport(invalidUserModel), /user model provider ID/);

  const invalidToolTime = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:tool-time`, sourceProvider: 'Claude Code', targetModel,
  });
  const tool = invalidToolTime.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool')!;
  ((tool.state as Record<string, unknown>).time as Record<string, unknown>).end = Number.NaN;
  assert.throws(() => inspectOfficialOpenCodeExport(invalidToolTime), /completed tool end time/);

  const invalidStepTokens = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:step-tokens`, sourceProvider: 'Claude Code', targetModel,
  });
  const finish = invalidStepTokens.messages.flatMap((message) => message.parts).find((part) => part.type === 'step-finish')!;
  const tokens = finish.tokens as Record<string, unknown>;
  (tokens.cache as Record<string, unknown>).read = Number.POSITIVE_INFINITY;
  assert.throws(() => inspectOfficialOpenCodeExport(invalidStepTokens), /step finish cache read tokens/);
});

test('official OpenCode session ID generation is stable for a reviewed source snapshot', () => {
  const createdAt = Date.parse('2026-09-08T03:00:00.000Z');
  const id = createOfficialOpenCodeSessionId(seed, createdAt);
  assert.equal(id, createOfficialOpenCodeSessionId(seed, createdAt));
  assert.notEqual(createOfficialOpenCodeSessionId(`${seed}:changed`, createdAt), createOfficialOpenCodeSessionId(seed, createdAt));
  const encoded = BigInt(`0x${id.slice(4, 16)}`);
  const expected = (~(BigInt(createdAt) * 0x1000n + 1n)) & 0xffffffffffffn;
  assert.equal(encoded, expected);
});

test('official OpenCode export supports user-only history and rejects misplaced tool events', () => {
  const userOnly = buildOfficialOpenCodeExport([
    { role: 'user', text: 'Interrupted before reply', timestamp: '2026-09-08T05:00:00.000Z' },
  ], cwd, { seed: `${seed}:user-only`, sourceProvider: 'Claude Code', targetModel });
  const summary = inspectOfficialOpenCodeExport(userOnly);
  assert.equal(summary.users, 1);
  assert.equal(summary.assistants, 0);

  assert.throws(() => buildOfficialOpenCodeExport([
    {
      role: 'user', text: 'bad event placement', timestamp: '2026-09-08T05:00:00.000Z',
      events: [{ kind: 'tool_call', summary: 'Read', timestamp: '2026-09-08T05:00:00.100Z', provider: 'claude' }],
    },
  ], cwd, { seed: `${seed}:bad-user-event`, sourceProvider: 'Claude Code', targetModel }), /does not support tool_call events on user turns/);
});

test('official OpenCode export rejects invalid or inconsistent target models', () => {
  assert.throws(() => buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:invalid-provider`, sourceProvider: 'Claude Code',
    targetModel: { providerID: 'bad/provider', modelID: 'model' },
  }), /target provider ID is invalid/);
  assert.throws(() => buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:invalid-model`, sourceProvider: 'Claude Code',
    targetModel: { providerID: 'opencode', modelID: 'bad\nmodel' },
  }), /target model ID is invalid/);

  const value = buildOfficialOpenCodeExport(richTurns(), cwd, {
    seed: `${seed}:inconsistent`, sourceProvider: 'Claude Code', targetModel,
  });
  value.messages[1]!.info.modelID = 'another-model';
  assert.throws(() => inspectOfficialOpenCodeExport(value), /inconsistent target models/);
});
