import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
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
 * Claude Code 项目设置的三类位置。
 *
 * - `repository-local`：在 Git 仓库的子目录启动时，个人本地覆盖写在**仓库根目录**的
 *   `.claude/settings.local.json`（前提见 `canUseRepositoryLocalSettings()`）。
 * - `project-local` / `project-shared`：当前目录下的本地覆盖与团队共享设置。
 */
export type ClaudeProjectRetentionScope = 'repository-local' | 'project-local' | 'project-shared';

export type ClaudeProjectRetentionProbe = ClaudeRetentionProbe & { scope: ClaudeProjectRetentionScope };

/** 当前目录下 Claude Code 会读取的两份项目设置（仓库根目录的 local 由 `probeClaudeProjectRetention()` 另加）。 */
export const CLAUDE_PROJECT_SETTINGS_RELATIVE_PATHS = [
  '.claude/settings.local.json',
  '.claude/settings.json',
] as const;

/**
 * 从 `cwd` 向上找最近的 Git 仓库根，不越过文件系统根。
 *
 * 只认 `.git` 是目录且含 `HEAD` 普通文件的情形：工作树 / 子模块的 `.git` 是文件，本地设置
 * 位置取决于主检出，这里不解析 gitdir，保守地不把当前目录当仓库根。`lstat` 读不出来时
 * 同样返回 null（不猜），避免把「无法确认」讲成「仓库没有更短的保留期」。
 */
async function findRepositoryRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const gitDir = path.join(dir, '.git');
      const entry = await lstat(gitDir);
      if (!entry.isDirectory()) return null;
      const head = await lstat(path.join(gitDir, 'HEAD'));
      return head.isFile() ? dir : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 官方规则：仓库根、它的 `.git` 或 `.claude` 不属于当前用户（以及 Windows、仓库根就是家目录）时，
 * Claude Code 把本地设置留在启动目录，不写到仓库根。判定不确定时一律返回 false——
 * 宁可漏报一份文件，也不能拿 Claude Code 不会加载的文件发警告。
 */
async function canUseRepositoryLocalSettings(root: string, home: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  if (path.resolve(root) === path.resolve(home)) return false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return false;
  const claudeDir = path.join(root, '.claude');
  for (const target of [root, path.join(root, '.git'), claudeDir]) {
    try {
      const entry = await lstat(target);
      if (entry.uid !== uid) return false;
    } catch (error) {
      // 仓库根没有 `.claude` 目录是正常情况；其余（含权限与类型异常）一律保守跳过
      if (target === claudeDir && isMissingPathEntryError(error)) continue;
      return false;
    }
  }
  return true;
}

function isMissingPathEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

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
 * 读取 Claude Code 可能加载的项目设置，按优先级排列：
 * 仓库根目录的 local（子目录启动时）→ 当前目录的 local → 当前目录的 shared。
 *
 * `cleanupPeriodDays` 的 scope 是「Any file」，项目设置因此可以覆盖用户设置；不探测这一层时，
 * doctor 只能给一句「项目或管理设置可能覆盖」。每个探针都把实际读的路径与位置带回去，
 * 调用方据此声明探测范围——不把「没读到」讲成「项目没有缩短保留期」。
 */
export async function probeClaudeProjectRetention(
  cwd: string,
  home: string = homedir(),
): Promise<ClaudeProjectRetentionProbe[]> {
  const targets: { settingsPath: string; scope: ClaudeProjectRetentionScope }[] = [];
  const add = (settingsPath: string, scope: ClaudeProjectRetentionScope): void => {
    if (!targets.some((t) => t.settingsPath === settingsPath)) targets.push({ settingsPath, scope });
  };
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (
    repositoryRoot !== null &&
    path.resolve(repositoryRoot) !== path.resolve(cwd) &&
    (await canUseRepositoryLocalSettings(repositoryRoot, home))
  ) {
    add(path.join(repositoryRoot, '.claude/settings.local.json'), 'repository-local');
  }
  add(path.join(cwd, '.claude/settings.local.json'), 'project-local');
  add(path.join(cwd, '.claude/settings.json'), 'project-shared');
  const probes: ClaudeProjectRetentionProbe[] = [];
  for (const target of targets) {
    probes.push({ ...(await probeClaudeSettingsFile(target.settingsPath)), scope: target.scope });
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
