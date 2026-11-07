export const AGENTS = [
  { id: 'claude', label: 'Claude Code', command: (id: string) => `claude --resume ${id}`, yolo: '--dangerously-skip-permissions' },
  { id: 'codex', label: 'OpenAI Codex', command: (id: string) => `codex resume ${id}`, yolo: '--dangerously-bypass-approvals-and-sandbox' },
  { id: 'opencode', label: 'OpenCode', command: (id: string) => `opencode -s ${id}`, yolo: '--auto' },
  { id: 'kimi', label: 'Kimi CLI', command: (id: string) => `kimi -r ${id}`, yolo: '--yolo' },
  { id: 'pi', label: 'Pi', command: (id: string) => `pi --session ${id}`, yolo: undefined },
  { id: 'grok', label: 'Grok CLI', command: (id: string) => `grok -r ${id}`, yolo: '--always-approve' },
];

/**
 * 已注册适配器里刻意不建桌面卡片的 provider（当前为空）。
 * 新增 Provider 时要么补卡片、要么加到这里；`tests/desktop-handoff-ui.test.ts` 会强制二者必居其一。
 * grok 在 2026-09-14 补齐：原生 `updates.jsonl`（ACP 会话日志）写入后，隔离验收通过
 * `grok sessions list` / `grok export` / ACP `session/load` 回放；真实终端里的 TUI 画面未逐帧验证。
 */
export const AGENTS_WITHOUT_CARD: readonly string[] = [];
export type Agent = typeof AGENTS[number];
export function handoffRoute(owner: string | null, target: string) {
  if (!owner) return 'unresolved';
  if (owner === target) return 'resume';
  return owner === 'claude' && target === 'codex' ? 'official-codex' : 'convert';
}

export type PrecheckBlocked = {
  code: string;
  sessionId?: string;
  holders?: { pid: number; command: string }[];
  hint?: string;
};

export type PrecheckResponse = {
  ok?: boolean;
  writable?: boolean;
  notes?: string[];
  /** 降级原因（复用扫描失败、链上配对读不出等）：与 notes 分开渲染，不再按 notes[1..] 猜 */
  warnings?: string[];
  sessionId?: string;
  error?: string;
  /** `open --check` 返回嵌套对象 `{code, sessionId, holders, hint}`；旧形状把字段放在顶层 */
  blocked?: boolean | PrecheckBlocked;
  code?: string;
  holders?: { pid: number; command: string }[];
  hint?: string;
};

/** 统一 `check_open` 的 blocked 形状；`open_in` 失败仍用顶层扁平字段，两条都要能读。 */
export function parsePrecheckBlocked(data: PrecheckResponse): PrecheckBlocked | undefined {
  const raw = data.blocked;
  if (!raw) return undefined;
  const detail = typeof raw === 'object' ? raw : data;
  return {
    code: detail.code ?? 'blocked',
    sessionId: detail.sessionId ?? data.sessionId,
    holders: detail.holders,
    hint: detail.hint,
  };
}
/**
 * `resolve_cwd`（= `watch open <id> --json`）带回的降级原因，供来源面板展示。
 *
 * CLI 侧在摘要 / 用量 / 来源解析读不出来时会写 `warnings`；桌面端此前只取 cwd / provider /
 * usage / summary，把这些警告丢掉后，读失败就只剩「未提供摘要」和「—」，和「原生确实没有」
 * 分不开。空串、非字符串条目直接丢弃，重复项只留一条。
 */
export function sourceWarnings(data: { warnings?: unknown } | null | undefined): string[] {
  const raw = data?.warnings;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export type HistoryView = {
  entries: unknown[];
  warnings: string[];
  /** `status` 失败（本地库打不开等）时的原因；成功但没有记录时为 null */
  error: string | null;
};

/**
 * 「接力记录」页的数据（`get_handoff_history` = `watch status --json`）。
 *
 * 以前前端只取 `history` 数组：`ok:false`（本地库打不开、库损坏）和 `warnings`
 * （链尾会话文件已不存在、读不出来）都被丢掉，页面照样显示「暂无接力记录」——
 * 把「没读成」讲成「没有记录」。这里把三种情况分开：记录 / 降级原因 / 失败原因。
 */
export function historyView(
  data: { ok?: unknown; error?: unknown; history?: unknown; warnings?: unknown } | null | undefined,
): HistoryView {
  const entries = Array.isArray(data?.history) ? (data!.history as unknown[]) : [];
  const warnings = sourceWarnings(data);
  let error: string | null = null;
  if (data && data.ok === false) {
    error = typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : '读取接力记录失败（status 没有返回原因）；请用 watch status --json 查看';
  }
  return { entries, warnings, error };
}

export function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }export function powershellQuote(value: string) { return `'${value.replace(/'/g, `''`)}'`; }
export function buildCommand(agent: Agent, id: string, cwd: string | undefined, yolo: boolean, windows = false) {
  // Native IDs are arguments, not shell fragments. Keep ordinary IDs readable.
  const argument = /^[a-zA-Z0-9_.:-]+$/.test(id) ? id : windows ? powershellQuote(id) : shellQuote(id);
  let command = agent.command(argument);
  if (yolo && agent.yolo) command += ` ${agent.yolo}`;
  if (!cwd) return command;
  return windows ? `Set-Location -LiteralPath ${powershellQuote(cwd)}; ${command}` : `cd ${shellQuote(cwd)} && ${command}`;
}

/** 主题偏好：亮色 / 暗色 / 跟随系统。持久化键 watch-theme；没保存过即跟随系统。 */
export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' }, { value: 'light', label: '亮色' }, { value: 'dark', label: '暗色' },
];
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
/** 偏好 + 系统是否为暗色 → 实际生效主题 */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
