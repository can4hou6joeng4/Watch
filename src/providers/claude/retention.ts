import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { describePathReadFailureReason } from '../../core/read-text.js';
import { claudeConfigDirFrom } from './build.js';

/**
 * Claude Code 官方默认的 transcript 保留期（天）。
 *
 * 官方 settings 参考：`cleanupPeriodDays` 是「number of days, a whole number, minimum 1」，
 * 默认 30；Claude Code 在会话启动后后台 sweep，超过期限的 transcript 会被删除且不提示，
 * 这些会话也不再出现在 `/resume` 里。对本工具的直接后果是：链尾一旦指向被清理的会话，
 * `open` / `switch` / `resume` 都会找不到内容——所以排障入口应当先说出来。
 */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * Claude Code 用户级设置里的保留期探针。
 *
 * **只读用户设置，不代表实际生效值**：官方把该键的 scope 记为「Any file」，
 * 项目 `.claude/settings.json`、`settings.local.json`、managed 设置与 CLI 参数都可能覆盖
 * 用户设置。因此这里回答的是「你的用户设置写了什么」，不是「Claude Code 最后用了多少天」。
 * 只读取 `cleanupPeriodDays` 一个键，不输出设置文件的其它内容。
 */
export type ClaudeRetentionProbe = {
  /** 实际读取的设置文件；`CLAUDE_CONFIG_DIR` 无效时为 null */
  settingsPath: string | null;
  /**
   * default = 用户设置文件不存在或未写这个键；defaultDays 仅是官方默认值。
   * configured = 读到一个合法值；
   * unknown = 设置读不出来 / 不是合法形状，无法确认用户是否覆盖了默认值。
   */
  state: 'default' | 'configured' | 'unknown';
  configuredDays: number | null;
  defaultDays: number;
  error?: string;
};

export type ParsedCleanupPeriodDays =
  | { state: 'default' }
  | { state: 'configured'; days: number }
  | { state: 'unknown'; error: string };

/** 非法值只说类型 / 数值，不回显字符串内容（设置文件里可能有别的东西） */
function describeInvalidCleanupValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? `值为 ${value}，官方要求不小于 1 的整数`
      : '值不是有限数字，官方要求不小于 1 的整数';
  }
  if (value === null) return '值为 null，官方要求不小于 1 的整数';
  if (Array.isArray(value)) return '值是数组，官方要求不小于 1 的整数';
  const type = typeof value;
  const typeText = type === 'object' ? '对象' : type === 'boolean' ? '布尔值' : type === 'string' ? '字符串' : type;
  return `值是${typeText}，官方要求不小于 1 的整数`;
}

/**
 * 解析 `settings.json` 原文里的 `cleanupPeriodDays`。
 *
 * 独立成纯函数：CLI / 测试都只依赖这段判定，判定不能只看 `parseInt()`——
 * `0`、负数、小数、字符串 `"7"` 都不是官方接受的「whole number, minimum 1」。
 * 顶层不是 JSON 对象时同样无法确认（`null` / `[]` / `42` 都是合法 JSON，但不是设置文件）。
 */
export function parseClaudeCleanupPeriodDays(raw: string): ParsedCleanupPeriodDays {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unknown', error: '设置文件不是合法 JSON，无法确认 cleanupPeriodDays' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'unknown', error: '设置文件顶层不是 JSON 对象，无法确认 cleanupPeriodDays' };
  }
  const value = (parsed as Record<string, unknown>).cleanupPeriodDays;
  if (value === undefined) return { state: 'default' };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return { state: 'configured', days: value };
  }
  return { state: 'unknown', error: `cleanupPeriodDays ${describeInvalidCleanupValue(value)}` };
}

/**
 * 当前目录下 Claude Code 会读取的两份项目设置，探针按这个顺序读。
 *
 * `settings.local.json` 是个人在本项目里的覆盖，优先级高于团队提交的 `settings.json`；
 * 两者都只从会话的主工作目录读取。仓库子目录启动时 Claude Code 还可能读取仓库根目录的
 * `settings.local.json`，这里不向上找——doctor 只声明「当前目录探测到了什么」。
 */
export const CLAUDE_PROJECT_SETTINGS_RELATIVE_PATHS = [
  '.claude/settings.local.json',
  '.claude/settings.json',
] as const;

/** 读取一个 Claude Code 设置文件里的 `cleanupPeriodDays`；只读、有界、非阻塞，不写盘。 */
export async function probeClaudeSettingsFile(settingsPath: string): Promise<ClaudeRetentionProbe> {
  const base = { settingsPath, defaultDays: CLAUDE_DEFAULT_CLEANUP_DAYS, configuredDays: null };
  const unknown = (error: string): ClaudeRetentionProbe => ({ ...base, state: 'unknown', error });
  let raw: string;
  try {
    // 非阻塞打开后检查同一个句柄。软链接可指向普通文件，FIFO 不会卡在 open。
    const file = await open(settingsPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return unknown('设置路径不是普通文件');
      const oversized = '设置文件超过 1 MiB 的诊断读取上限';
      if (info.size > MAX_SETTINGS_BYTES) return unknown(oversized);
      // 多读一个字节区分恰好达到上限与读取过程中继续增长的文件。
      const bytes = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_SETTINGS_BYTES) return unknown(oversized);
      raw = bytes.toString('utf8', 0, total);
    } finally {
      await file.close();
    }
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return { ...base, state: 'default' };
    if (code === 'ENOTDIR') return unknown('设置路径有一级不是目录');
    if (code === 'EISDIR') return unknown('设置路径不是普通文件');
    return unknown(`读取设置文件失败：${describePathReadFailureReason(error)}`);
  }
  const parsed = parseClaudeCleanupPeriodDays(raw);
  if (parsed.state === 'default') return { ...base, state: 'default' };
  if (parsed.state === 'configured') return { ...base, state: 'configured', configuredDays: parsed.days };
  return { ...base, state: 'unknown', error: parsed.error };
}

/** 读取指定 Claude 配置目录下的用户设置 `settings.json`；只读，不写盘、不改设置。 */
export async function probeClaudeRetentionDir(configDir: string): Promise<ClaudeRetentionProbe> {
  return probeClaudeSettingsFile(path.join(configDir, 'settings.json'));
}

/**
 * 读取当前目录下 Claude Code 会加载的项目设置（local 在前、shared 在后）。
 *
 * `cleanupPeriodDays` 的 scope 是「Any file」，项目设置因此可以覆盖用户设置；不探测这一层时，
 * doctor 只能给一句「项目或管理设置可能覆盖」，把「这个项目把保留期调成了 3 天」讲成泛泛的可能。
 * 只读当前目录、不向上找仓库根：每个探针都把实际读的路径带回去，由调用方声明探测范围。
 */
export async function probeClaudeProjectRetention(cwd: string): Promise<ClaudeRetentionProbe[]> {
  const probes: ClaudeRetentionProbe[] = [];
  for (const relativePath of CLAUDE_PROJECT_SETTINGS_RELATIVE_PATHS) {
    probes.push(await probeClaudeSettingsFile(path.join(cwd, relativePath)));
  }
  return probes;
}

/**
 * 按原生定位规则找 Claude 配置目录（`CLAUDE_CONFIG_DIR` 优先），再读用户设置。
 * 环境变量非法时返回 `unknown`，不让 `watch doctor` 因一个变量直接崩掉——
 * 同一份报告里的会话列表 / 写入预检会各自给出更具体的目录错误。
 */
export async function probeClaudeRetention(home: string = homedir()): Promise<ClaudeRetentionProbe> {
  let configDir: string;
  try {
    configDir = claudeConfigDirFrom(home);
  } catch (error) {
    return {
      settingsPath: null,
      state: 'unknown',
      configuredDays: null,
      defaultDays: CLAUDE_DEFAULT_CLEANUP_DAYS,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return probeClaudeRetentionDir(configDir);
}
