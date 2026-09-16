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
export function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
export function powershellQuote(value: string) { return `'${value.replace(/'/g, `''`)}'`; }
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
