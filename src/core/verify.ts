import { userTurnTextForWrite } from './rich.js';
import type { ProcessEvent, UnifiedTurn } from './types.js';

/**
 * 目标写入侧对工具调用的受控变换：给出**回读后**应有的工具名与入参。
 * 由适配器提供（例如 Claude 的包装值会被 parser 还原），校验器只负责逐值比较。
 */
export type ToolCallExpectation = (event: ProcessEvent) => { name: unknown; input: unknown };

/** 入参按 JSON 语义归一：键序不参与比较，写出时会丢掉的 undefined 字段同样忽略。 */
function canonicalToolInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalToolInput(item)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = canonicalToolInput(record[key]);
    }
    return out;
  }
  return value;
}

function sameToolInput(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalToolInput(a)) === JSON.stringify(canonicalToolInput(b));
}

/**
 * round-trip 自校验：importTurns 写出的内容被自家 parse 反解后，关键内容必须与输入一致。
 * 只比「关键内容」：role 序列、trim 后 text、每 turn 的事件 kind 计数、tool_call 的 callId；
 * 不比 summary/detail 文案，避免展示层调整误伤。
 * - 输入侧先丢弃全空 turn（无文本且无事件）——与各家 builder 的行为对齐
 * - callId：输入侧已定义的必须出现在解析结果中（builder 生成的 id 不要求反向存在）
 * - `expectToolCall`（可选）：逐值比较工具名与入参。以前同一 callId 下换掉 `Read` 的文件路径
 *   也照样通过；目标侧有受控变换时由适配器给出期望，未提供时保持旧口径（不比入参）。
 */
export function assertRoundTrip(
  input: UnifiedTurn[],
  parsed: UnifiedTurn[],
  provider: string,
  expectToolCall?: ToolCallExpectation,
): void {
  const fail = (reason: string): never => {
    throw new Error(`[${provider}] round-trip 校验失败: ${reason}`);
  };

  const wanted = input.filter((t) => t.text.trim() !== '' || (t.events?.length ?? 0) > 0);
  if (wanted.length !== parsed.length) {
    fail(`turn 数不一致，期望 ${wanted.length} 实得 ${parsed.length}`);
  }
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i]!;
    const p = parsed[i]!;
    if (w.role !== p.role) fail(`#${i} role 不一致，期望 ${w.role} 实得 ${p.role}`);
    if (w.text.trim() !== p.text.trim()) fail(`#${i} (${w.role}) 文本不一致`);
    for (const kind of ['thinking', 'tool_call', 'tool_result'] as const) {
      const wc = (w.events ?? []).filter((e) => e.kind === kind).length;
      const pc = (p.events ?? []).filter((e) => e.kind === kind).length;
      if (wc !== pc) fail(`#${i} (${w.role}) ${kind} 计数不一致，期望 ${wc} 实得 ${pc}`);
    }
    const wantIds = (w.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id));
    const gotIds = new Set((p.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id)));
    const missing = wantIds.filter((id) => !gotIds.has(id));
    if (missing.length) fail(`#${i} (${w.role}) 丢失 callId: ${missing.join(', ')}`);
    if (expectToolCall) {
      const wantCalls = (w.events ?? []).filter((e) => e.kind === 'tool_call');
      const gotCalls = (p.events ?? []).filter((e) => e.kind === 'tool_call');
      // 工具调用计数已在上面对齐，这里按写出顺序成对比较。
      for (let j = 0; j < wantCalls.length; j++) {
        const wantEvent = wantCalls[j]!;
        const got = gotCalls[j]!;
        const want = expectToolCall(wantEvent);
        const label = wantEvent.callId ? `callId: ${wantEvent.callId}` : `第 ${j + 1} 个调用`;
        if (got.name !== want.name) {
          fail(`#${i} (${w.role}) 工具名不一致（${label}），期望 ${String(want.name)} 实得 ${String(got.name)}`);
        }
        if (!sameToolInput(got.input, want.input)) {
          fail(`#${i} (${w.role}) 工具 ${String(want.name)} 的入参不一致（${label}）`);
        }
      }
    }
  }
}

/**
 * 不支持附件块、只能把附件降级成正文占位的目标（pi / kimi / grok 只搬正文）共用的
 * round-trip 期望变换。**两个角色都要变换**：用户轮附件写进正文早已如此；助手轮的
 * 纯附件轮以前被 build 写成空内容，占位与原始数据一起消失，现在同样落进正文。
 */
export function expectAttachmentPlaceholders(turns: UnifiedTurn[]): UnifiedTurn[] {
  return turns.map((t) => {
    const text = userTurnTextForWrite(t);
    return text === t.text ? t : { ...t, text };
  });
}

/**
 * 写出内容校验器：parse(tmp) 后与输入 turns 对账。
 * 两段式：先全量比对（覆盖 replace 全量重写）；
 * 失败则退化为「从首个 user turn 起的后缀比对」——parse 会丢弃首条 user 之前的
 * assistant 记录，且 grok/pi 的追加是 existing+new 全量重写，全量比对会误报。
 */
export async function verifyWrittenTurns(opts: {
  parse: (filePath: string) => Promise<UnifiedTurn[]>;
  filePath: string;
  turns: UnifiedTurn[];
  provider: string;
  /** 写出侧受控降级的期望变换（如 claude thinking→[思考] 文本）：先变换输入再比对 */
  expect?: (turns: UnifiedTurn[]) => UnifiedTurn[];
  /** 逐值比较工具名与入参；目标侧有受控变换时由适配器提供（缺省保持旧口径） */
  expectToolCall?: ToolCallExpectation;
}): Promise<void> {
  const expected = opts.expect ? opts.expect(opts.turns) : opts.turns;
  const parsed = await opts.parse(opts.filePath);
  try {
    assertRoundTrip(expected, parsed, opts.provider, opts.expectToolCall);
    return;
  } catch {
    // 退化为后缀比对
  }
  const firstUser = expected.findIndex((t) => t.role === 'user');
  if (firstUser < 0) {
    if (parsed.length >= expected.length) {
      try {
        assertRoundTrip(expected, parsed.slice(parsed.length - expected.length), opts.provider, opts.expectToolCall);
        return;
      } catch {
        // 比对末尾失败，继续抛出全量差异
      }
    }
    assertRoundTrip(expected, parsed, opts.provider, opts.expectToolCall); // 无 user turn：重抛全量差异
  }
  // 遍历全部同名 user 候选起点逐一尝试对齐：grok 等会话含历史重放副本时，
  // 固定取「最后一个匹配」会切出残段误报（append 的旧段里也有同名 user）
  const needle = expected[firstUser]!.text.trim();
  let lastError: Error | null = null;
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i]!;
    if (t.role !== 'user' || t.text.trim() !== needle) continue;
    try {
      assertRoundTrip(expected.slice(firstUser), parsed.slice(i), opts.provider, opts.expectToolCall);
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`[${opts.provider}] round-trip 校验失败: 首条 user 消息未出现在写出的会话中`);
}
