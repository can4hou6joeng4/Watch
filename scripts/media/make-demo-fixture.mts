import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildClaudeLines, encodeClaudeProjectDir } from '../../src/providers/claude/build.js';
import type { UnifiedTurn } from '../../src/core/types.js';
const home = process.env.DEMO_HOME!, cwd = process.env.DEMO_CWD!;
const id = '7d3c2a10-5b8e-4f61-9c4d-2e0a8b7f1c33';
const t = (m: number) => new Date(Date.UTC(2026, 8, 13, 9, m)).toISOString();
const ev = (kind: 'thinking'|'tool_call'|'tool_result'|'text', summary: string, extra: Partial<UnifiedTurn['events'] extends (infer E)[] | undefined ? E : never> = {}, m = 0) => ({ kind, summary, timestamp: t(m), provider: 'claude', ...extra });
const turns: UnifiedTurn[] = [
  { role: 'user', text: '调用方反馈 /orders 接口偶发 502。请先复现，再定位重试逻辑的问题。', timestamp: t(0) },
  { role: 'assistant', text: '复现成功：上游超时后 fetchWithRetry 没有退避，第二次请求紧接着发出并再次超时，网关返回 502。问题在 src/http/retry.ts 的循环里。', timestamp: t(2), events: [
    ev('thinking', '先看重试实现，再用日志复现', { detail: '先看重试实现，再用日志复现' }, 1),
    ev('tool_call', 'Bash: grep -rn "retry" src/http', { name: 'Bash', callId: 'toolu_01', input: { command: 'grep -rn "retry" src/http' } }, 1),
    ev('tool_result', '2 matches', { name: 'Bash', callId: 'toolu_01', detail: 'src/http/retry.ts:12:export async function fetchWithRetry(\nsrc/http/client.ts:40:  return fetchWithRetry(url, init, 3);' }, 1),
    ev('tool_call', 'Read: src/http/retry.ts', { name: 'Read', callId: 'toolu_02', input: { file_path: 'src/http/retry.ts' } }, 2),
    ev('tool_result', '31 lines', { name: 'Read', callId: 'toolu_02', detail: 'for (let i = 0; i < attempts; i++) {\n  try { return await fetch(url, init); }\n  catch (e) { last = e; }\n}' }, 2),
  ] },
  { role: 'user', text: '加指数退避，上限 3 次，总时长不超过 2 秒，并补一个测试。', timestamp: t(4) },
  { role: 'assistant', text: '已改为 200ms 起步的指数退避（200 / 400 / 800ms），总计 1.4s；新增 tests/retry.test.ts 覆盖超时后成功与三次全失败两种情况。测试通过，还没有提交。', timestamp: t(7), events: [
    ev('tool_call', 'Edit: src/http/retry.ts', { name: 'Edit', callId: 'toolu_03', input: { file_path: 'src/http/retry.ts', old_string: 'catch (e) { last = e; }', new_string: 'catch (e) { last = e; await sleep(200 * 2 ** i); }' } }, 5),
    ev('tool_result', 'ok', { name: 'Edit', callId: 'toolu_03', detail: 'The file src/http/retry.ts has been updated.' }, 5),
    ev('tool_call', 'Write: tests/retry.test.ts', { name: 'Write', callId: 'toolu_04', input: { file_path: 'tests/retry.test.ts', content: '// two cases: recover after timeout, fail after 3 attempts' } }, 6),
    ev('tool_result', 'ok', { name: 'Write', callId: 'toolu_04', detail: 'File created successfully.' }, 6),
    ev('tool_call', 'Bash: npm test -- tests/retry.test.ts', { name: 'Bash', callId: 'toolu_05', input: { command: 'npm test -- tests/retry.test.ts' } }, 7),
    ev('tool_result', '2 passed', { name: 'Bash', callId: 'toolu_05', detail: '✔ recovers after one timeout\n✔ fails after 3 attempts\nℹ tests 2\nℹ pass 2' }, 7),
  ] },
  { role: 'user', text: '顺便看看 client.ts 里其他调用方有没有也需要退避的。', timestamp: t(9) },
];
const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd));
mkdirSync(dir, { recursive: true });
const lines = buildClaudeLines(turns, id, cwd, { model: 'claude-sonnet-4-5', version: '2.1.0' });
writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
console.log('fixture:', path.join(dir, `${id}.jsonl`), lines.length, 'lines');
