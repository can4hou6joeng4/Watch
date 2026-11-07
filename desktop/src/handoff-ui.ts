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

/**
 * `list_terminals` 的返回值过滤：只留桌面端认识的终端 id。
 * `copy` 是前端加的选项（仅复制命令），不是可拉起的终端；一个都不剩时退回系统终端，
 * 否则下拉框会是空的、连「系统终端」都选不到。
 */
export function usableTerminals(list: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(list)) return ['terminal'];
  const ids = list.filter((entry): entry is string => typeof entry === 'string' && entry !== 'copy' && known.includes(entry));
  return ids.length ? ids : ['terminal'];
}

export type ProviderDetectFailure = { id: string; label: string; error: string };

/**
 * `list_available_providers`（= `watch providers --json`）里 detect() 抛错的那几家。
 *
 * 契约是「一家检测崩掉不影响整体」：该项 `available:false` 并带 `error`。桌面端此前只读
 * `available`，把「读不出来 / 探测失败」和「没装 CLI」渲染成同一句「CLI 未检测到」——
 * 用户会去重装一个其实装着、只是配置读不出来的客户端。
 */
export function providerDetectFailures(providers: unknown): ProviderDetectFailure[] {
  if (!Array.isArray(providers)) return [];
  const out: ProviderDetectFailure[] = [];
  for (const entry of providers) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { id?: unknown; available?: unknown; error?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const error = typeof record.error === 'string' ? record.error.trim() : '';
    if (!id || record.available !== false || !error) continue;
    const label = AGENTS.find((agent) => agent.id === id)?.label ?? id;
    out.push({ id, label, error });
  }
  return out;
}

export type RecentView = {
  items: unknown[];
  /** 被 `--limit` 截断的条数（0 表示这一份就是全部） */
  omitted: number;
  warnings: string[];
  error: string | null;
};

/**
 * 侧边栏「近期会话」的数据（`list_recent_sessions` = `watch recent --json`）。
 *
 * CLI 侧会为「单家会话列表读不出来」「映射表读失败」「撞到列表上限 50 条」各写一条
 * `warnings`，并把跳过的来源记进 `unavailable`；桌面端以前只取 `sessions` / `truncated`，
 * 于是「有几家没读到」和「更早的会话没进列表」都显示成一份看起来完整的列表。
 * 这里把 `unavailable` 的名单放最前面（原因由 CLI 写在 `warnings` 里，紧跟其后），
 * 让「列表不完整」这件事本身可见。
 */
export function recentView(
  data: {
    ok?: unknown; error?: unknown; sessions?: unknown; warnings?: unknown; unavailable?: unknown;
    truncated?: unknown; total?: unknown;
  } | null | undefined,
): RecentView {
  const items = Array.isArray(data?.sessions) ? (data!.sessions as unknown[]) : [];
  const warnings = sourceWarnings(data);
  const skipped = Array.isArray(data?.unavailable)
    ? (data!.unavailable as unknown[]).filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
    : [];
  const parts: string[] = [];
  if (skipped.length) parts.push(`这几家本次没有读出会话：${skipped.join(' / ')}；下面的近期列表因此不完整`);
  parts.push(...warnings);

  let error: string | null = null;
  if (data && data.ok === false) {
    error = typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : '读取近期会话失败（recent 没有返回原因）；请用 watch recent --json 查看';
  } else if (data && data.ok === true && !Array.isArray(data.sessions)) {
    // ok:true 却没有 sessions：内容不合契约，别渲染成「暂无近期会话」
    error = '读取近期会话失败（recent 没有返回会话列表）；请用 watch recent --json 查看';
  }

  const total = typeof data?.total === 'number' ? data.total : 0;
  const omitted = data?.truncated === true && total > items.length ? total - items.length : 0;
  return { items, omitted, warnings: parts, error };
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
