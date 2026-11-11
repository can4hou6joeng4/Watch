import { spawn } from 'node:child_process';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { PreflightBlockedError, type PreflightContext, type ProviderAdapter, type WriteLimit } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { escapeControlChars } from '../../core/display.js';
import { parseOpencodeSession } from './parse.js';
import { detectOpencodeLayout } from './paths.js';
import {
  createEmptyOpencodeSession,
  findLatestOpencodeSession,
  findOpencodeSessionById,
  importTurnsToOpencode,
  listOpencodeSessions,
  opencodeDbPath,
} from './build.js';

function refFromSessionId(sessionId: string, cwd: string): SessionRef {
  return { provider: 'opencode', sessionId, filePath: opencodeDbPath(), cwd };
}

function replyTurn(text: string): UnifiedTurn {
  return {
    role: 'assistant',
    text,
    timestamp: new Date().toISOString(),
    provider: 'opencode',
  };
}

/** 从 opencode run 的 stdout 里提取 assistant 回复文本 */
function parseRunOutput(stdout: string): string {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
    if (line && !line.startsWith('>') && !line.startsWith('█') && !line.includes('opencode')) {
      return line;
    }
  }
  return '';
}

async function runOpencode(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCli('opencode'), args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      // opencode CLI 在 stdin 被关闭时会自我终止，因此继承 stdin；stdout/stderr 捕获。
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('opencode CLI 调用超时'));
    }, 120_000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`opencode CLI 启动失败: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.slice(0, 500) || `exit ${code} signal ${signal}`;
        reject(new Error(`opencode CLI 调用失败: ${detail}`));
        return;
      }
      resolve(parseRunOutput(stdout));
    });
  });
}

export {
  findLatestOpencodeSession,
  listOpencodeSessions,
  opencodeDbPath,
};

/**
 * 信息层：链上这条 opencode 会话一共用了多少 token。
 *
 * 口径刻意与搬运层复用同一个 `parseOpencodeSession()`，而不是直接累加 `message.data.tokens`：
 * ① `messageUsage()` 已按 OpenCode 的非重叠分解求和（input + cache.read + cache.write、
 *    output + reasoning），两条路径共用一份折算，不会再分叉；
 * ② Watch 自己写出的工具轮把**同一份** usage 写在两条 message 上（tool-calls 与
 *    final text），直接累加 message 行会翻倍，而 parse 已把它们合并成一个 turn、
 *    用量只留一份；
 * ③ 0/0 占位在 `messageUsage()` 里已被丢弃，不会把「源侧没有用量」算成真实 0 token。
 *
 * 没有 assistant usage 时返回 null（表示「原生没有用量记录」），读不出来照常抛出——
 * 与另外五家 `sessionUsage` 的约定一致，`chainUsage()` 会据此区分 `totalMissingUsage`
 * 与读取失败。
 */
async function opencodeSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  const dbPath = ref.filePath || opencodeDbPath();
  // 2.x（2026-11-11 起只读支持）的用量记在 session_v2 的累计列里，本机没有原生样本验证
  // 「累计列与逐条消息是否同一口径」。返回 null 会被讲成「这条会话没有用量数据」，所以抛错，
  // 由 chainUsage / open 记成「读取失败」并给警告——宁可说没查成，也不说成 0。
  if (detectOpencodeLayout(dbPath) === 'v2') {
    throw new Error(
      `OpenCode 2.x 布局的 token 口径 Watch 还没验证（2.x 把用量记在 session_v2 的累计列里，` +
        `与逐条消息是否一致未知）：${escapeControlChars(dbPath)}；这条会话不计入合计——不代表它没有用过 token`,
    );
  }
  const turns = await parseOpencodeSession(ref);
  let inputTokens = 0;
  let outputTokens = 0;
  let saw = false;
  for (const turn of turns) {
    if (!turn.usage) continue;
    saw = true;
    inputTokens += turn.usage.inputTokens;
    outputTokens += turn.usage.outputTokens;
  }
  return saw ? { inputTokens, outputTokens } : null;
}

/**
 * 只读探测：这个 OpenCode 库能不能写。返回 null = 可写。
 *
 * `preflight` 与 `writeLimit`（doctor 用）共用这一份判定，同一件事不能有两条说法：
 * preflight 把它包成 `PreflightBlockedError`，doctor 把它印成「能读不能写」。
 * 判的是 `opencodeDbPath()`：写路径（`createEmptyOpencodeSession` / `importTurnsToOpencode`）
 * 都写这个库，而不是 `ctx.ref.filePath`。
 */
function opencodeWriteLimit(): WriteLimit | null {
  const dbPath = opencodeDbPath();
  if (detectOpencodeLayout(dbPath) !== 'v2') return null;
  return {
    code: 'opencode_v2_readonly',
    reason:
      `OpenCode 数据库是 2.x 布局（表: session_v2 / session_message）：${escapeControlChars(dbPath)}；` +
      `Watch 能读取这种布局，但写入只在 1.x（session / message / part）上验证过`,
    hint:
      `未写入任何内容。可以用 watch open <会话 id> 在原生的 OpenCode 2.x 里继续；` +
      `或把 WATCH_OPENCODE_DB 指向一个 1.x 布局的库再转入；` +
      `不要删除或挪走这个库——那是 OpenCode 正在使用的数据`,
  };
}

/**
 * 写入前的布局检查：2.x 库只读（读路径 2026-11-11 起支持，写路径还没验证）。
 *
 * 不在这里拦的话，`open --to opencode --check` 会先报 `writable: true`，到真正写入时
 * 才由 `assertUsableOpencodeDb()` 抛错——预检说的和实际做的相反。`open` / `switch` /
 * `handoff` 三条写路径都会先调 preflight，所以这里给出的是同一句结构化 `blocked`。
 */
async function opencodePreflight(_ctx?: PreflightContext): Promise<void> {
  const limit = opencodeWriteLimit();
  if (!limit) return;
  throw new PreflightBlockedError({ code: limit.code, message: limit.reason, hint: limit.hint });
}

export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',

  preflight: opencodePreflight,
  writeLimit: async (): Promise<WriteLimit | null> => opencodeWriteLimit(),

  async detect(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // spawn 的 `timeout` 选项在 `'error'`（命令不存在）之后不会清掉自己的定时器：进程会一直挂到
      // 超时才退出——2026-11-08 实测 `watch providers` 在任何没装 opencode 的机器上都固定卡 10 秒
      // （其余五家用 execFile，超时正确清理，同一命令 0.1 秒就返回）。这里自己做定时器，四条出口都清。
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      // 二进制存在但不可执行（如 bun postinstall 未跑的 shim 无 shebang）时 spawn 会同步抛 ENOEXEC
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolveCli('opencode'), ['--version'], { stdio: 'ignore' });
      } catch (error) {
        // 同步抛错只可能是 spawn 阶段（ENOENT / EACCES / ENOEXEC）：仍然是「没装」与「装了但起不来」之分
        finish(() =>
          isCommandMissing(error)
            ? resolve(false)
            : reject(new Error(describeDetectFailure('opencode', error))),
        );
        return;
      }
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new Error(describeDetectFailure('opencode', { killed: true, signal: 'SIGTERM' }))));
      }, 10_000);
      child.on('error', (error) => {
        // 同上：命令不存在才是没装；权限 / 格式问题要报检测失败
        finish(() =>
          isCommandMissing(error)
            ? resolve(false)
            : reject(new Error(describeDetectFailure('opencode', error))),
        );
      });
      child.on('exit', (code, signal) => {
        // 非零退出 / 被信号终止：命令装上了但跑不起来，不能说成「未检测到」
        finish(() =>
          code === 0 ? resolve(true) : reject(new Error(describeDetectFailure('opencode', { code, signal }))),
        );
      });
    });
  },

  parse: parseOpencodeSession,
  importTurns: importTurnsToOpencode,
  // build 把 attachment 写回 file part（图片与文件都带数据）
  attachmentSupport: 'all',
  findLatestSession: findLatestOpencodeSession,
  listSessions: listOpencodeSessions,
  findById: findOpencodeSessionById,
  sessionUsage: opencodeSessionUsage,

  async createEmptySession(cwd: string): Promise<SessionRef> {
    return createEmptyOpencodeSession(cwd);
  },

  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    // opencode run --auto <msg> 在当前服务端版本会报 UnknownError，因此先建空会话再 send。
    const ref = await createEmptyOpencodeSession(cwd);
    const turn = await this.send(ref, text, onEvent);
    return { ref, turn };
  },

  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const replyText = await runOpencode(['run', '--session', ref.sessionId, '--auto', text], ref.cwd);
    if (onEvent) {
      // opencode run 不输出细粒度事件；后续可扩展
    }
    return replyTurn(replyText);
  },

  resumeCommand(ref: SessionRef): string {
    return `opencode -s ${ref.sessionId}`;
  },
};
