import { realpath, stat } from 'node:fs/promises';
import type { ProviderAdapter, WriteLimit } from '../providers/adapter.js';
import { listAdapters, listProviders } from '../providers/registry.js';
import type { ProviderInfo } from './types.js';
import type { Chain, ChainsElsewhere } from './store.js';
import type { ImportJobs } from './import-jobs.js';
import { defaultDbPath, describeStoreErrorReason } from './store.js';
import { diffTurns, rebindHint } from './handoff.js';
import type { SessionRef } from './types.js';
import { readWatchVersion } from './watch-version.js';
import { describeCwdProblem, inspectCwd, splitElsewhereByDirectory, type CwdInspection } from './cwd.js';
import { clipCodePoints, escapeControlChars } from './display.js';
import { describeBadLinesScanFailure, scanUnparsableJsonLines, unparsableLinesField, type BadLinesScan } from './jsonl.js';
import { compressedCopy, compressedRetryAdvice, describeSessionReadFailureReason, isEmptySessionFileReason, isFileSystemErrorCode, probeSessionReadable, sessionFilePresence } from './read-text.js';
import { collectUnattributable, unattributableWarning } from './session-coverage.js';
import { CLAUDE_DEFAULT_CLEANUP_DAYS, hasHigherPrecedenceClaudeRetentionSetting, probeClaudeProjectRetention, probeClaudeRetention, resolveEffectiveClaudeRetention, type ClaudeProjectRetentionProbe, type ClaudeRetentionProbe } from '../providers/claude/retention.js';

export type BrokenTip = {
  chainId: string;
  chainName: string;
  provider: string;
  sessionId: string;
  filePath: string;
  error: string;
  /** true = 文件确认不在（ENOENT / ENOTDIR）；false = 读不出来，无法确认是否还在 */
  missing: boolean;
  /**
   * 原文件不在、但同名 `.jsonl.zst` 压缩副本在时的副本路径（Codex 的本地线程压缩）。
   * 这时说「已不存在」会把人引去重新绑定，而会话其实还在——本版只是不读压缩格式。
   * 存路径而不是布尔值：逐链行要打印真正存在的那个文件，打印不存在的 `.jsonl` 会误导排障。
   */
  compressedPath?: string;
  /**
   * true = `compressedPath` 是 0 字节副本：文件还在原处，内容却已丢失。
   * 下一步只能是备份恢复或重开会话，不能沿用「让它重新展开」。
   */
  compressedEmpty?: boolean;
  /**
   * true = 文件在、是普通文件，但打不开（`chmod 000` 之类）。
   *
   * `stat` 成功不代表读得出来，所以这一档既不能进 `missing`（文件没丢），也不能当成
   * 健康链尾（`resume` 与下次切换一读内容就失败）。`status` / `chain list` / `new`
   * 对同一状态都会披露，`doctor` 作为排障入口必须给出同一档结论。
   */
  unreadable?: boolean;
};

/**
 * 链尾文件在、也读得出来，但解析结果是 0 轮：`resume` 打开就是空会话。
 *
 * 这不是「不可用」（`brokenTips`），也不是「内容落后于来源」（`driftedPairs`）：
 * 文件本身没问题，只是里面没有可继续的对话。`status` 用 `chainTipEmpty` 说同一档，
 * 排障入口不能说成一切正常；`watch new` 刚建出来的空链尾也属于这一档（通常无需处理）。
 */
export type EmptyTip = {
  chainId: string;
  chainName: string;
  provider: string;
  sessionId: string;
  filePath: string;
  /** 0 轮同一次扫描确认的坏行；扫描未完成时有 `error` 且 `count` 是下界，干净文件不输出 */
  badLines?: BadLinesScan;
};

/** 报告来源：贴到 issue 里要能定位「哪一版、什么环境、看的是哪个库」 */
export type DoctorEnvironment = {
  watchVersion: string | null;
  node: string;
  platform: string;
  dbPath: string;
  importsRoot: string | null;
};

/** 链尾与来源的内容对账：`missingTurns > 0` 说明目标会话比来源少了记录 */
export type DriftedPair = {
  chainId: string;
  chainName: string;
  from: { provider: string; sessionId: string };
  to: { provider: string; sessionId: string };
  missingTurns: number;
  sourceTurns: number;
};

/**
 * Watch 自己占用的磁盘：库文件（含 `-wal` / `-shm`）与搜索索引规模。
 *
 * 各家原生会话体积不归 Watch 管，这里只回答「这个工具自己吃了多少」。索引里的内容
 * 全部可由会话文件重建，所以体积是可回收的——但回收动作会连链记录一起丢，文案里必须说清。
 * 读不出来的项一律给 `null`，不拿 0 冒充「空库」。
 */
export type StoreFootprint = {
  /** `WATCH_DB=:memory:`：不落盘，下面的字节数与计数全部为 null */
  ephemeral: boolean;
  /** 尚未建库（ENOENT）时报 0：这是「还没写过」，不是「读不到」 */
  dbBytes: number | null;
  walBytes: number | null;
  shmBytes: number | null;
  /** 搜索索引：文本段数 / 覆盖会话数 / 覆盖目录数 */
  indexRows: number | null;
  indexSessions: number | null;
  indexDirectories: number | null;
  /**
   * 文件里已归还但未释放的页（`PRAGMA freelist_count × page_size`）：只有 `VACUUM` 才真正缩小文件。
   * 只报文件大小会被读成「删了索引就省空间」，而 SQLite 删除行从不缩文件。
   */
  reclaimableBytes: number | null;
  /** 体积或计数读不出来时的原因；此时对应字段为 null */
  error?: string;
};

/** 每家 Agent 的原生会话列表可读性：`count` 为 null 表示读取失败 */
export type StorageProbe = {
  provider: string;
  count: number | null;
  error?: string;
  /** 计数已达适配器 `listSessionsCap`：实际会话数只会更多，不能当精确总数用 */
  capped?: boolean;
  /**
   * 文件列得出来、但预览读不出来（`chmod 000` 之类）的会话数。
   *
   * `count` 只说明「目录里有几条」，`stat` 对读不出来的文件照常成功，所以不加这一档时
   * doctor 会对一条 open / switch 必然失败的会话报告“N 个会话”，看起来一切正常。
   */
  unreadable?: number;
  /**
   * 连「属于哪个 cwd」都读不出来、因而没有进任何目录列表的条目数（目前只有 Codex 的
   * `session_meta` 坏掉的 rollout）。
   *
   * 与 `unreadable` 的区别：那一档知道会话 id 与路径、只是内容读不出；这一档连归属都没有，
   * `sessions` / `recent` 里根本不会出现，四条通道都不说话，用户会以为它从来没存在过。
   */
  unattributable?: number;
  /**
   * 读不出来的容器位置数（如 Kimi 的工作区分组）。
   *
   * 与 `unattributable` 分开：那一档数会话文件，这一档数目录——一个分组里可能有 0 到几十条会话，
   * 混进同一个数字会少报。两者都让 `count` 变成下界，文本行分别说明。
   */
  unattributableLocations?: number;
  /**
   * 这个存储只能读、不能写（如 OpenCode 2.x 布局）：`count` 读得出来，但转入 / switch
   * 会被 preflight 拒绝。只报条数时 doctor 看起来一切正常，用户要到一次失败的写入
   * 才知道写不了——排障入口该先说出来。
   */
  writeLimit?: WriteLimit;
  /** `writeLimit` 探测本身失败（不能当成「没有限制」） */
  writeLimitError?: string;
};

export type DoctorReport = {
  cwd: string;
  /**
   * `--cwd` 不可用时的结构化状态：与 status / sessions / recent / usage / search 的
   * `--json` 同一组取值（`missing` / `not-directory` / `denied` / `unknown`，后者附 reason）。
   * 文本模式只有 warnings 里的中文说明，CI / 脚本据此把「路径写错」与「确实没有会话」分开；
   * 健康目录不出现。
   */
  cwdState?: CwdInspection;
  environment: DoctorEnvironment;
  providers: ProviderInfo[];
  storage: StorageProbe[];
  /** 本地库自身的磁盘占用与索引规模 */
  storeFootprint: StoreFootprint;
  /**
   * Claude Code 用户设置里的 transcript 保留期（只读 `cleanupPeriodDays`）。
   *
   * 不是「实际生效值」：项目 / local / managed 设置都可能覆盖用户设置。
   * 排障入口报出来，是因为链尾指向被原生清理的会话时 `open` / `resume` 会直接找不到内容；
   * 显式设成低于默认值时进 warnings，让 `--strict` 能发现这个风险。
   */
  claudeRetention: ClaudeRetentionProbe;
  /**
   * 当前诊断目录下 Claude Code 会加载的项目设置探针，按优先级排列：仓库根目录的 local
   * （在普通 Git 仓库的子目录启动时）→ 当前目录的 local → 当前目录的 shared。
   * `cleanupPeriodDays` 的 scope 是「Any file」，项目设置可以覆盖用户设置；
   * 工作树 / 子模块、归属异常、管理设置与 `--settings` 不在探测范围。
   */
  claudeProjectRetention: ClaudeProjectRetentionProbe[];
  store:
    | {
        available: true;
        /**
         * 这次诊断在库文件不存在时新建了它（含目录与迁移）。`openStore()` 会建库，
         * 帮助行已如实说明；报告里再点一次，用户才知道眼前这个 0 条链的库是刚建出来的。
         * 字段只在为 true 时出现（与其它「缺省即无此事」的字段一致）。
         */
        created?: boolean;
        chains: number;
        activeChains: number;
        /**
         * 本地库里属于其它目录的链（本目录没有链时才有内容）。
         * 「本目录 0 条链」是结论：不指出它在哪，用户会以为链丢了或没建成功。
         */
        chainsElsewhere: ChainsElsewhere[];
        brokenTips: BrokenTip[];
        driftedPairs: DriftedPair[];
        emptyTips: EmptyTip[];
      }
    | { available: false; error: string };
  imports:
    | {
        available: true;
        total: number;
        imported: number;
        associated: number;
        uncertain: number;
        prepared: number;
        /** 结果未知的计划 id（最多 10 个）：文本模式要能直接照着跑 status，不能只报个数 */
        uncertainIds: string[];
        /** 读不出来被跳过的日志条数：不计入上面的统计，否则用户只会看到总数凭空少了 */
        skipped: number;
        /** 被跳过的日志与原因（最多 10 个）：只说「有 N 条读不出」同样没法排查 */
        skippedJournals: { id: string; reason: string }[];
        /** 目录里不是计划目录的条目数：它们不进 total，不说就会让「共 N 条」比目录里实际有的少 */
        ignored: number;
        /** 这些条目与形状（最多 10 个） */
        ignoredEntries: { name: string; reason: string }[];
      }
    | { available: false; error: string };
  warnings: string[];
  /**
   * 结论性汇总：doctor 是排障入口，脚本 / CI 需要一个不靠解析中文文本的判断。
   *
   * 只有 `fail` 让默认退出码非零——「警告」是已经披露的降级（内容漂移、单条会话读不出来、
   * uncertain 计划…），把它们也变成红灯会让一次平常的排障在 CI 里失败；`--strict` 才升级。
   * `failures` 逐条列出硬问题（Watch 现在确实做不成某件事），不是只给个数。
   */
  summary: DoctorSummary;
};

export type DoctorSummary = {
  status: 'ok' | 'warn' | 'fail';
  /** 硬问题：本地库不可用 / 某家会话列表读不出来 / 链尾不可用 / CLI 装了但起不来 */
  failures: string[];
  /** 与 `warnings` 长度一致，方便只读 summary 的调用方判断有没有降级 */
  warnings: number;
};

/** 诊断用的最小 Store 面：列出当前 cwd 的链、读某条链的切换记录；测试可注入假实现 */
export type DoctorStore = {
  listChains(cwd: string): Chain[];
  /** 列出其它目录的链（可选：注入的假 Store 可以不给，报告里就是空数组） */
  chainsElsewhere?(cwd: string): ChainsElsewhere[];
  listSwitchEvents?(chainId: string): {
    fromRef?: SessionRef | null;
    toRef?: SessionRef | null;
  }[];
  /** 搜索索引规模（可选：注入的假 Store 可以不给，报告里就是 null） */
  indexFootprint?(): { rows: number; sessions: number; directories: number };
  /** 可被 VACUUM 回收的字节数（可选，同上） */
  reclaimableBytes?(): number | null;
};

export type DoctorDeps = {
  /** 默认读注册表；测试注入假适配器 */
  adapters?: ProviderAdapter[];
  store: DoctorStore | null;
  storeError?: string;
  /**
   * 打开本地库之前它并不存在（由 CLI 判）：`openStore()` 会创建目录、建库并迁移。
   * 只在库可用时置真——打开失败时说不清文件是怎么留下的。
   */
  storeCreated?: boolean;
  importJobs: ImportJobs | null;
  importJobsError?: string;
  /** 执行日志根目录（供报告标注路径）；不传则报告记为 null */
  importsRoot?: string;
  /**
   * 本地库是 `WATCH_DB=:memory:`（由 CLI 判）时的一条说明。
   *
   * 这一档库是**好的**——读得到、写也成功，只是每条命令都是全新的空库。于是「本目录 0 条链」
   * 会被读成「你从来没建过链」，而真正的原因是链记录只活在上一条命令的进程里。
   * 排障入口说不出这一点的后果最严重：用户正是来问「为什么全是 0」的。
   */
  ephemeralNote?: string;
  /** 测试可覆盖；默认读当前进程与 package.json */
  environment?: DoctorEnvironment;
  /** 测试可覆盖；默认只读 Claude Code 用户设置里的 cleanupPeriodDays */
  claudeRetention?: ClaudeRetentionProbe;
  /** 测试可覆盖；默认探测诊断目录与普通 Git 仓库根目录下的 Claude 项目设置 */
  claudeProjectRetention?: ClaudeProjectRetentionProbe[];
};

type PathPresence =
  | { state: 'present'; mtimeMs: number | null }
  | { state: 'unreadable'; reason: string }
  | { state: 'missing'; code: string; compressed?: string; emptyCompressed?: string }
  | { state: 'unknown'; reason: string };

/**
 * 只有 ENOENT / ENOTDIR 才算「文件不在」。EACCES / EIO 等读不出来时不能说成已删除，
 * 否则权限问题会被讲成「下次切换会失败，先 adopt」，把人引去白换一次绑定。
 * 路径存在但不是普通文件（被同名目录 / 设备文件占住）同样不是「还在」：说成 present
 * 会让后面的 parse 抛出裸 `EISDIR: illegal operation on a directory, read`，
 * 而 `type: 'present'` 也不该用来表示「读不出内容」——`watch chain list` 对同一状态
 * 说的是「该路径现在不是普通文件」，两处要一致。
 */
async function pathPresence(filePath: string): Promise<PathPresence> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      // `stat` 对 `chmod 000` 照常成功：文件在、是普通文件，但内容读不出来。
      // 只按 `stat` 判 present 会让 doctor 对一条 resume 必然失败的链尾保持沉默。
      const readProblem = await probeSessionReadable(filePath);
      if (readProblem) return { state: 'unreadable', reason: readProblem };
      return { state: 'present', mtimeMs: info.mtimeMs };
    }
    return { state: 'unknown', reason: '该路径现在不是普通文件（被同名目录或设备文件占住了）' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 与 `sessionFilePresence()` 同一判定：Codex 压缩过时原路径不在、`.jsonl.zst` 在。
      // 这一次复查可能撞上 TOCTOU（第一次 stat 与这次之间文件被换成不可读的路径），
      // unknown 时照实返回 unknown——按 missing 讲会把「读不出来」说成「已被删除」。
      const presence = await sessionFilePresence(filePath);
      if (presence.state === 'missing') {
        return {
          state: 'missing',
          code,
          ...(presence.compressed ? { compressed: presence.compressed } : {}),
          ...(presence.emptyCompressed ? { emptyCompressed: presence.emptyCompressed } : {}),
        };
      }
      if (presence.state === 'unknown') return { state: 'unknown', reason: presence.reason };
      // 这里只可能是压缩副本还在：原文件没有 stat 结果，保留期风险判断跳过
      return { state: 'present', mtimeMs: null };
    }
    return { state: 'unknown', reason: describeSessionReadFailureReason(error) };
  }
}

/**
 * 量一下 Watch 自己占了多大：库文件三个（db / wal / shm）各自 stat，索引规模问 Store。
 * 两项独立降级——`stat` 不到不该连带索引计数一起变成「未知」，反过来也一样。
 */
async function probeStoreFootprint(dbPath: string, store: DoctorStore | null): Promise<StoreFootprint> {
  if (dbPath === ':memory:') {
    return {
      ephemeral: true,
      dbBytes: null,
      walBytes: null,
      shmBytes: null,
      indexRows: null,
      indexSessions: null,
      indexDirectories: null,
      reclaimableBytes: null,
    };
  }
  let statError: string | undefined;
  // ENOENT 报 0：这是「还没建过库」，与「读不出来」下一步相反，不能混成一档
  const bytes = async (path: string): Promise<number | null> => {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      statError ||= `${escapeControlChars(path)}：${describeStoreErrorReason(error)}`;
      return null;
    }
  };
  const dbBytes = await bytes(dbPath);
  const walBytes = await bytes(`${dbPath}-wal`);
  const shmBytes = await bytes(`${dbPath}-shm`);
  let counts: { rows: number; sessions: number; directories: number } | null = null;
  let reclaimable: number | null = null;
  let countError: string | undefined;
  try {
    counts = store?.indexFootprint?.() ?? null;
  } catch (error) {
    countError = describeStoreErrorReason(error);
  }
  try {
    reclaimable = store?.reclaimableBytes?.() ?? null;
  } catch (error) {
    countError ||= describeStoreErrorReason(error);
  }
  const error = [statError, countError].filter(Boolean).join('；');
  return {
    ephemeral: false,
    dbBytes,
    walBytes,
    shmBytes,
    indexRows: counts?.rows ?? null,
    indexSessions: counts?.sessions ?? null,
    indexDirectories: counts?.directories ?? null,
    reclaimableBytes: reclaimable,
    ...(error ? { error } : {}),
  };
}

function resolveEnvironment(importsRoot: string | null): DoctorEnvironment {  return {
    watchVersion: readWatchVersion(),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    dbPath: process.env.WATCH_DB ?? defaultDbPath(),
    importsRoot,
  };
}

/**
 * 只读环境诊断：各项独立降级，任一失败只记入对应字段或 warnings，不影响其它项。
 * 不写库、不写原生会话、不启动外部 CLI（providers 的 detect 只做 PATH 探测）。
 */
export async function doctorReport(cwd: string, deps: DoctorDeps): Promise<DoctorReport> {
  const warnings: string[] = [];
  // 硬问题与 warnings 分开记：这不是同一种东西。警告是「已经降级但说清楚了」，
  // 失败是「Watch 现在做不成某件事」——只有后者该让 exit code 非零
  const failures: string[] = [];
  const environment = deps.environment ?? resolveEnvironment(deps.importsRoot ?? null);

  // 路径本身错了，下面每项都会安静地返回 0，看起来像「一切正常」——先把它说清楚。
  // 探测结果留到报告里：`--json` 只有 warnings 时脚本得解析中文才知道 --cwd 不可用
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  if (cwdIssue) warnings.push(cwdIssue);
  // 符号链接是另一类「路径没写错但匹配不到」：provider 按原生记录的字符串精确比较，
  // 用另一写法打开过的会话不会出现在这里。先记下 realpath，等扫完会话再决定要不要提醒。
  let realCwd: string | null = null;
  if (!cwdIssue) {
    try {
      const real = await realpath(cwd);
      if (real !== cwd) realCwd = real;
    } catch {
      /* stat 已经成功；realpath 失败不额外报，避免同一路径报两次 */
    }
  }

  const adapters = deps.adapters ?? listAdapters();
  const providers = await listProviders(adapters);

  // Claude Code 的 transcript 保留期：用户设置读不出来只是「无法确认」，不是 Watch 的故障；
  // 显式设得比官方默认更短则意味着链尾可能在用户不知情时被原生清理。只读，不修改设置。
  let claudeRetention: ClaudeRetentionProbe;
  try {
    claudeRetention = deps.claudeRetention ?? (await probeClaudeRetention());
  } catch (error) {
    claudeRetention = {
      settingsPath: null,
      state: 'unknown',
      configuredDays: null,
      defaultDays: CLAUDE_DEFAULT_CLEANUP_DAYS,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (claudeRetention.state === 'unknown') {
    const settingsPath = claudeRetention.settingsPath ? `（${escapeControlChars(claudeRetention.settingsPath)}）` : '';
    warnings.push(
      `Claude Code 的会话保留期无法确认${settingsPath}：${escapeControlChars(claudeRetention.error ?? '原因未知')}。官方默认保留 ${CLAUDE_DEFAULT_CLEANUP_DAYS} 天，请核对实际使用的设置`,
    );
  } else if (
    claudeRetention.state === 'configured' &&
    claudeRetention.configuredDays !== null &&
    claudeRetention.configuredDays < CLAUDE_DEFAULT_CLEANUP_DAYS
  ) {
    const settingsPath = claudeRetention.settingsPath ? `${escapeControlChars(claudeRetention.settingsPath)} ` : '';
    warnings.push(
      `Claude Code 用户设置（${settingsPath}）把 cleanupPeriodDays 设为 ${claudeRetention.configuredDays} 天，低于官方默认 ${CLAUDE_DEFAULT_CLEANUP_DAYS} 天。这个值若在 Claude Code 中生效，超过期限的会话记录可能被清理，导致 open / resume 找不到内容。请核对项目或管理设置的覆盖情况，并提前备份重要会话`,
    );
  }

  // 项目设置可以覆盖用户设置（scope 是 Any file）。按优先级探测：仓库根目录的 local
  // （普通 Git 仓库的子目录）→ 当前目录的 local → 当前目录的 shared；工作树 / 子模块、
  // 归属异常、管理设置与 `--settings` 不在范围内，所以只声明读到了什么，
  // 不把「没读到」讲成「项目没有缩短保留期」。
  let claudeProjectRetention: ClaudeProjectRetentionProbe[];
  // 探针整体失败时，项目设置是「不知道」而不是「没设置」。不能随后拿用户设置或默认值
  // 估算链尾风险——那等于替一份可能覆盖它的项目设置猜了个结论。
  let claudeProjectRetentionFailed = false;
  try {
    claudeProjectRetention = deps.claudeProjectRetention ?? (await probeClaudeProjectRetention(cwd));
  } catch (error) {
    // 每个文件探针自己 catch；这里只兜底路径拼接 / 向上查找等意外，不能静默当成「没设置」
    claudeProjectRetention = [];
    claudeProjectRetentionFailed = true;
    warnings.push(
      `Claude Code 的项目保留期设置没能探测：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const probedScope = claudeProjectRetention.some((probe) => probe.scope === 'repository-local')
    ? '本次探测了当前目录与仓库根目录的 .claude/ 设置'
    : '本次探测了当前目录的 .claude/ 设置';
  for (const probe of claudeProjectRetention) {
    const settingsPath = probe.settingsPath ? escapeControlChars(probe.settingsPath) : '项目设置文件';
    const subject = probe.scope === 'repository-local' ? 'Claude Code 仓库根目录的项目设置' : 'Claude Code 项目设置';
    if (probe.state === 'unknown') {
      warnings.push(
        `${subject}无法确认（${settingsPath}）：${escapeControlChars(probe.error ?? '原因未知')}。若 Claude Code 在该目录加载这份设置，就无法判断它是否缩短了会话保留期`,
      );
    } else if (
      probe.state === 'configured' &&
      probe.configuredDays !== null &&
      probe.configuredDays < CLAUDE_DEFAULT_CLEANUP_DAYS &&
      // 仓库根目录的 local 覆盖启动目录的 local，项目 local 又覆盖 shared。
      // 更高优先级已经写了这个键时，这一份不会生效，不能拿它发清理风险警告。
      !hasHigherPrecedenceClaudeRetentionSetting(probe, claudeProjectRetention)
    ) {
      const location =
        probe.scope === 'repository-local'
          ? 'Claude Code 在 Git 仓库的子目录启动时会读取仓库根目录的 settings.local.json；若会话在该仓库启动'
          : 'Claude Code 从会话的主工作目录读取项目设置；若会话在该目录启动且没有被更高优先级的设置覆盖';
      warnings.push(
        `${subject}（${settingsPath}）把 cleanupPeriodDays 设为 ${probe.configuredDays} 天，低于官方默认 ${CLAUDE_DEFAULT_CLEANUP_DAYS} 天。${location}，超过期限的会话记录可能被清理，导致 open / resume 找不到内容。${probedScope}；管理设置与 --settings 不在范围，请核对实际加载的设置并提前备份重要会话`,
      );
    }
  }

  // 链尾会话如果比「Claude Code 按已探测设置会读取的那份保留期」还旧，下一次启动后的
  // 清理就可能把它删掉。不能取所有探针里的最短值：高层设置写了更长的值就会覆盖低层，
  // 拿被覆盖的短值报警会把用户引去改一份根本不生效的文件。高层设置读不出来时也不猜，
  // 只保留上面已发出的 unknown 警告。没有显式短设置时不用官方默认 30 天报警：老链尾
  // 很多时候是有意保留的归档，拿默认值喊会变成噪音。
  const effectiveRetention = resolveEffectiveClaudeRetention(claudeRetention, claudeProjectRetention);
  const riskRetentionDays =
    !claudeProjectRetentionFailed &&
    effectiveRetention.state === 'configured' &&
    effectiveRetention.days < CLAUDE_DEFAULT_CLEANUP_DAYS
      ? effectiveRetention.days
      : null;

  // 原生会话列表只读；与 detect（只看 PATH）互补：装了但存储读不出，比「没装」更需要解释
  const storage: StorageProbe[] = [];
  // 列得出、但预览读不出来的会话。链尾由下面的 brokenTips 单独说（更具体、带下一步），
  // 这里收集是为了覆盖「不是链尾、却同样打不开」的那一类
  const unreadableSessions: { provider: string; sessionId: string; filePath: string; reason: string }[] = [];
  // 连归属都读不出来、因而没进任何目录列表的条目。它不属于任何 cwd，所以只能在全局诊断里说
  // 统计与文案都在 `session-coverage.ts`：`sessions` / `recent` / `status` 说的是同一句话，
  // 同一份数据在四个入口上不能有两套说法
  const unattributableStats = await collectUnattributable(adapters);
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    // 列表读取与写入能力独立；目录坏了导致列表失败时，仍需保留写入故障的 code 和建议。
    let writeLimit: WriteLimit | null = null;
    let writeLimitError: string | undefined;
    if (adapter.writeLimit) {
      try {
        writeLimit = await adapter.writeLimit(cwd);
      } catch (error) {
        writeLimitError = error instanceof Error ? error.message : String(error);
        warnings.push(
          `${adapter.displayName} 写入能力探测失败：${writeLimitError}；这不代表可以写入，转入前先用 watch open --check 确认`,
        );
      }
      // 可修故障进入 warnings；已知只读布局只显示在正文，不因它使 --strict 常红。
      if (writeLimit?.kind === 'fault') {
        warnings.push(`${adapter.displayName} 当前无法写入：${writeLimit.reason}`);
      }
    }
    const writeState = {
      ...(writeLimit ? { writeLimit } : {}),
      ...(writeLimitError ? { writeLimitError } : {}),
    };
    try {
      const listed = await adapter.listSessions(cwd);
      const capped = adapter.listSessionsCap !== undefined && listed.length >= adapter.listSessionsCap;
      const unreadable = listed.filter((item) => item.previewError);
      for (const item of unreadable) {
        unreadableSessions.push({
          provider: adapter.id,
          sessionId: item.ref.sessionId,
          filePath: item.ref.filePath,
          reason: item.previewError as string,
        });
      }
      const unattributableStat = unattributableStats.find((s) => s.provider === adapter.id);
      const unattributable = unattributableStat?.count;
      const unattributableLocations = (unattributableStat?.locations ?? []).reduce((n, l) => n + l.count, 0);
      storage.push({
        provider: adapter.id,
        count: listed.length,
        ...(capped ? { capped: true } : {}),
        ...(unreadable.length ? { unreadable: unreadable.length } : {}),
        ...(unattributable ? { unattributable } : {}),
        ...(unattributableLocations ? { unattributableLocations } : {}),
        ...writeState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storage.push({ provider: adapter.id, count: null, error: message, ...writeState });
      warnings.push(`${adapter.displayName} 会话列表读取失败：${message}`);
      failures.push(`${adapter.displayName} 会话列表读不出来`);
    }
  }

  if (realCwd && storage.length > 0 && storage.every((s) => s.count === 0)) {
    warnings.push(
      `--cwd 是符号链接（realpath: ${realCwd}），且本目录没扫到任何会话；各 provider 按原生记录的路径字符串精确比较，若曾在另一写法下开过会话，换该路径重跑 watch doctor`,
    );
  }

  let store: DoctorReport['store'];
  if (!deps.store) {
    store = { available: false, error: deps.storeError ?? '本地库未打开' };
    failures.push('本地库不可用');
    // 只写「未打开」看不出是权限、库损坏还是被占用；doctor 是排障入口，原因必须带出来
    if (deps.storeError) warnings.push(`本地库不可用，无法列出链与做内容对账：${deps.storeError}`);
  } else {
    try {
      const chains = deps.store.listChains(cwd);
      const activeChains = chains.filter((c) => c.status === 'active');
      const brokenTips: BrokenTip[] = [];
      // 可读 0 轮链尾（`chainTipEmpty` 的 doctor 同档）：不在 brokenTips 里——
      // 文件没坏，坏的是「resume 打开是空会话」这个预期
      const emptyTips: EmptyTip[] = [];
      // 内容对账里 parse 成功过的链：链尾轮数已经在那边判断过，补漏循环不再读一次
      const reconciledTips = new Set<string>();
      const adapterById = new Map(adapters.map((a) => [a.id, a]));
      const listEvents = deps.store.listSwitchEvents?.bind(deps.store);
      for (const chain of activeChains) {
        if (!listEvents) break;
        let tip: { provider: string; sessionId: string; filePath: string } | null | undefined;
        try {
          tip = listEvents(chain.id).at(-1)?.toRef;
        } catch (error) {
          // SQLite 的原文（`database is locked` / `no such table`）既不说是哪一类故障也不给下一步，
          // 与 handoff.ts / open.ts 的同类警告保持一致，统一翻成中文
          warnings.push(`链「${escapeControlChars(chain.name)}」的切换记录读取失败：${describeStoreErrorReason(error)}`);
          failures.push(`链「${escapeControlChars(chain.name)}」的切换记录读不出来`);
          continue;
        }
        if (!tip) continue;
        const tipPresence = await pathPresence(tip.filePath);
        if (tipPresence.state !== 'present') {
          const unreadable = tipPresence.state === 'unreadable';
          const missing = tipPresence.state === 'missing';
          const copy = missing
            ? compressedCopy({
                state: 'missing',
                compressed: tipPresence.compressed,
                emptyCompressed: tipPresence.emptyCompressed,
              })
            : null;
          const compressed = missing ? (tipPresence.compressed ?? tipPresence.emptyCompressed) : undefined;
          const compressedEmpty = missing && !!tipPresence.emptyCompressed;
          const error = missing ? tipPresence.code : tipPresence.reason;
          brokenTips.push({
            chainId: chain.id,
            chainName: chain.name,
            provider: tip.provider,
            sessionId: tip.sessionId,
            filePath: tip.filePath,
            error,
            missing,
            ...(compressed ? { compressedPath: compressed } : {}),
            ...(compressedEmpty ? { compressedEmpty: true } : {}),
            ...(unreadable ? { unreadable: true } : {}),
          });
          failures.push(
            `链「${escapeControlChars(chain.name)}」的链尾不可用（${copy ? (compressedEmpty ? '只剩 0 字节压缩副本（内容已丢失）' : '只剩压缩副本') : missing ? '文件已不存在' : unreadable ? '读不出来' : '文件状态无法确认'}）`,
          );
          if (copy) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话${copy.note}（${tip.provider}）；下次切换会失败——${compressedRetryAdvice(copy, '再重试')}，或${rebindHint(tip.provider)}`,
            );
          } else if (missing) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件已不存在：${tip.filePath}（${tip.provider}）；下次切换会失败，${rebindHint(tip.provider)}`,
            );
          } else if (unreadable) {
            // 「读不出来」既不是「文件丢了」也不是「无法确认它还在」：文件明明白白在，
            // 只是内容读不出来。说成「已不存在」会把人引去重新绑定，说成「状态无法确认」
            // 又会让人以为可能是路径问题——两处都修不好一个权限。
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件读不出来：${tip.filePath}（${tip.provider}）；${error}；resume 与下次切换都会失败——先修好这个文件（权限或内容），或 watch switch ${tip.provider} 重新绑定，或 watch chain new <新名字> 另起一条链`,
            );
          } else {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件状态无法确认：${tip.filePath}（${tip.provider}）；${error}；先确认它是否还在、是否是普通文件，再决定是否 adopt`,
            );
          }
        } else if (
          riskRetentionDays !== null &&
          tip.provider === 'claude' &&
          tipPresence.mtimeMs !== null
        ) {
          // 只对 Claude 会话判断：cleanupPeriodDays 是 Claude Code 的设置。
          // 用文件 mtime 估「最后一次写入」，而不是断言原生一定按这个时间清理。
          const ageDays = Math.floor((Date.now() - tipPresence.mtimeMs) / 86_400_000);
          if (ageDays >= riskRetentionDays) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾是 Claude Code 会话（${escapeControlChars(tip.filePath)}），文件已经有 ${ageDays} 天没有更新，而按已探测设置的优先级生效的 cleanupPeriodDays 是 ${riskRetentionDays} 天；若没有更高优先级的设置覆盖，Claude Code 启动后的清理可能删除它——先备份该文件，或调大保留期，或${rebindHint(tip.provider)}`,
            );
          }
        }
      }
      // 内容对账：链尾文件还在，不代表它也还在内容上承接来源（手动改过、客户端截断、resume 重写都会让两者漂移）
      const driftedPairs: DriftedPair[] = [];
      for (const chain of activeChains) {
        if (!listEvents) break;
        let last: { fromRef?: SessionRef | null; toRef?: SessionRef | null } | undefined;
        try {
          last = listEvents(chain.id).at(-1);
        } catch {
          continue; // 上面已按链警告过读取失败
        }
        const from = last?.fromRef;
        const to = last?.toRef;
        if (!from || !to) continue; // 链起点没有来源，无从对账
        const fromAdapter = adapterById.get(from.provider);
        const toAdapter = adapterById.get(to.provider);
        if (!fromAdapter?.parse || !toAdapter?.parse) continue;
        // 文件确认不在已有 brokenTips / 专门警告，别再让 parse 抛 ENOENT 重复报一次；
        // 但「读不出来」要单独说，`continue` 静默跳过会被当成「对账通过」
        const toPresence = await pathPresence(to.filePath);
        if (toPresence.state === 'missing') continue;
        // 链尾读不出来已经在上面 brokenTips / 链尾警告里说过一遍（含「先修好这个文件」的下一步），
        // 这里再补一句「未做内容对账」只是同一件事讲两遍，反而把真正可执行的建议淹没
        if (toPresence.state === 'unreadable') continue;
        if (toPresence.state === 'unknown') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的链尾会话文件状态无法确认：${to.filePath}（${to.provider}）；读不出来（${toPresence.reason}），本次未做内容对账`,
          );
          continue;
        }
        const fromPresence = await pathPresence(from.filePath);
        if (fromPresence.state === 'missing') {
          const copy = compressedCopy({
            state: 'missing',
            compressed: fromPresence.compressed,
            emptyCompressed: fromPresence.emptyCompressed,
          });
          warnings.push(
            copy
              ? `链「${escapeControlChars(chain.name)}」的来源会话${copy.note}（${from.provider}）；链尾仍在，但无法再做内容对账——${compressedRetryAdvice(copy, '再重跑 watch doctor')}`
              : `链「${escapeControlChars(chain.name)}」的来源会话文件已不存在：${from.filePath}（${from.provider}）；链尾仍在，但无法再做内容对账`,
          );
          continue;
        }
        // 来源会话读不出来：链尾没问题，但这一条链的内容对账做不成，来源侧也打不开
        if (fromPresence.state === 'unreadable') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话文件读不出来：${from.filePath}（${from.provider}）；${fromPresence.reason}；本次未做内容对账——先修好这个文件（权限或内容），再重跑 watch doctor`,
          );
          continue;
        }
        if (fromPresence.state === 'unknown') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话文件状态无法确认：${from.filePath}（${from.provider}）；读不出来（${fromPresence.reason}），本次未做内容对账`,
          );
          continue;
        }
        // parse 对坏行一律跳过：两边都坏时 diffTurns 可能「看起来对齐」，实际上内容已经丢了，
        // 内容对账（只比解析结果）永远查不出来，只能在这里主动报
        const [fromBadScan, toBadScan] = await Promise.all([
          scanUnparsableJsonLines(from.filePath),
          scanUnparsableJsonLines(to.filePath),
        ]);
        if (fromBadScan.count > 0) {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话 ${from.sessionId}（${from.provider}）有 ${fromBadScan.count} 行无法解析（截断或损坏）：切换时这些内容会被跳过`,
          );
        }
        if (toBadScan.count > 0) {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的链尾会话 ${to.sessionId}（${to.provider}）有 ${toBadScan.count} 行无法解析（截断或损坏）：内容对账与增量判定可能不准`,
          );
        }
        // 坏行数不出来时，上面两句「有 N 行」都不成立，但也不能读成「没有坏行」
        const fromBadFailure = describeBadLinesScanFailure(
          fromBadScan,
          `链「${escapeControlChars(chain.name)}」的来源会话 ${from.sessionId}（${from.provider}）`,
          '内容对账与增量判定是否准确无法确认——先确认该文件可读再重跑 watch doctor',
        );
        if (fromBadFailure) warnings.push(fromBadFailure);
        const toBadFailure = describeBadLinesScanFailure(
          toBadScan,
          `链「${escapeControlChars(chain.name)}」的链尾会话 ${to.sessionId}（${to.provider}）`,
          '内容对账与增量判定是否准确无法确认——先确认该文件可读再重跑 watch doctor',
        );
        if (toBadFailure) warnings.push(toBadFailure);
        try {
          const [fromTurns, toTurns] = await Promise.all([fromAdapter.parse(from), toAdapter.parse(to)]);
          reconciledTips.add(chain.id);
          // 0 轮空链尾：文件可读、parse 成功，但没有可继续的对话。这一档不走
          // 「比来源少 N 条记录」——那是内容漂移的说法；链尾本来就空时，说漂移会把
          // 人引去 switch / adopt 重新对齐，而真正该做的是把内容补回来或另起一条链。
          if (toTurns.length === 0) {
            const toBadLines = unparsableLinesField(null, toBadScan).unparsableLines?.target;
            emptyTips.push({
              chainId: chain.id,
              chainName: chain.name,
              provider: to.provider,
              sessionId: to.sessionId,
              filePath: to.filePath,
              ...(toBadLines ? { badLines: toBadLines } : {}),
            });
            // 与未进入对账的链尾同档：toBadScan 已在上面算过，parse 跳过坏行时
            // 「0 轮」不能讲成刚建出来 / 内容被清空；不要把人引去 switch / adopt 重新对齐。
            const subject = `链「${escapeControlChars(chain.name)}」的链尾会话 ${to.provider} ${to.sessionId}`;
            const tailReason = toBadScan.count > 0
              ? `文件里有 ${toBadScan.count} 行无法解析（截断或损坏），这些内容已被跳过——更可能是文件被截断或损坏，不能当成「刚建出来的空会话」`
              : toBadFailure ?? '如果刚 watch new 建出来还没聊过属正常，先在该会话里继续';
            warnings.push(
              `${subject} 是空的（解析出 0 轮，没有可继续的对话）：${tailReason}${toBadFailure ? `；${toBadFailure}` : ''}；` +
                `下次切换会「成功」，但打开的是空会话——若它本该有历史，先从备份恢复该文件（不属正常新建），` +
                `或 watch switch ${to.provider} 重新绑定，或 watch chain new <新名字> 另起一条链`,
            );
            continue;
          }
          const missingTurns = diffTurns(fromTurns, toTurns).length;
          if (missingTurns > 0) {
            driftedPairs.push({
              chainId: chain.id,
              chainName: chain.name,
              from: { provider: from.provider, sessionId: from.sessionId },
              to: { provider: to.provider, sessionId: to.sessionId },
              missingTurns,
              sourceTurns: fromTurns.length,
            });
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾比来源少 ${missingTurns} 条记录（来源 ${fromTurns.length} 条）：若切换后又在来源侧继续聊过属正常，下次切换会补齐；否则可能是目标会话被改动或截断，可用 switch / adopt 重新对齐`,
            );
          }
        } catch (error) {
          // parse 顺带把文件读进来：EACCES / EIO / EMFILE 这类 fs 错误是「读不出来」，
          // 不是「内容对不上」。原样塞进警告只剩一句英文 errno（`EACCES: permission denied, open '…'`），
          // 用户既看不出该修权限还是该查内容，也不知道这一项其实没做成。
          if (isFileSystemErrorCode((error as NodeJS.ErrnoException).code)) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的内容对账未进行：${describeSessionReadFailureReason(error)}；先确认来源 / 链尾会话文件是否可读，再重跑 watch doctor`,
            );
          } else {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`链「${escapeControlChars(chain.name)}」的内容对账失败：${message}`);
          }
        }
      }
      // 对账只覆盖「有来源、且链尾 parse 成功」的链：`watch new` 建出的链没有 fromRef，
      // 从没走进上面的循环。补一遍——文件在、读得出来、却解析出 0 轮的链尾，正是
      // resume 打开空会话的直接原因，排障入口不能对它沉默（与 status 的 chainTipEmpty 同档）。
      if (listEvents) {
        for (const chain of activeChains) {
          if (reconciledTips.has(chain.id)) continue;
          let tip: SessionRef | null | undefined;
          try {
            tip = listEvents(chain.id).at(-1)?.toRef;
          } catch {
            continue; // 上面已按链警告过切换记录读取失败
          }
          if (!tip) continue;
          const tipAdapter = adapterById.get(tip.provider);
          if (!tipAdapter?.parse) continue;
          const presence = await pathPresence(tip.filePath);
          // missing / unreadable / unknown 已由 brokenTips 逐条说过，这里不重复
          if (presence.state !== 'present') continue;
          try {
            const turns = await tipAdapter.parse(tip);
            if (turns.length === 0) {
              // 与 status / chain list 同档：parse 跳过坏行，0 轮也可能是文件截断或损坏。
              // 排障入口尤其不能把「文件坏了」讲成「刚建出来还没聊过」。
              const subject = `链「${escapeControlChars(chain.name)}」的链尾会话 ${tip.provider} ${tip.sessionId}`;
              const badScan = await scanUnparsableJsonLines(tip.filePath);
              const tipBadLines = unparsableLinesField(null, badScan).unparsableLines?.target;
              emptyTips.push({
                chainId: chain.id,
                chainName: chain.name,
                provider: tip.provider,
                sessionId: tip.sessionId,
                filePath: tip.filePath,
                ...(tipBadLines ? { badLines: tipBadLines } : {}),
              });
              const badFailure = describeBadLinesScanFailure(
                badScan,
                subject,
                '是否真的只有 0 轮无法确认——先确认该文件可读再重跑 watch doctor',
              );
              const reason = badScan.count > 0
                ? `文件里有 ${badScan.count} 行无法解析（截断或损坏），这些内容已被跳过——更可能是文件被截断或损坏，不能当成「刚建出来的空会话」`
                : badFailure ?? '如果刚 watch new 建出来还没聊过属正常，先在该会话里继续';
              warnings.push(
                `${subject} 是空的（解析出 0 轮，没有可继续的对话）：${reason}；` +
                  `resume 打开就是空会话——若它本该有历史，先从备份恢复该文件（不属正常新建），` +
                  `或 watch switch ${tip.provider} 重新绑定，或 watch chain new <新名字> 另起一条链`,
              );
            }
          } catch (error) {
            // parse 抛错说明内容整体读不出来（坏行由上面的 scanUnparsableJsonLines 单独说）：
            // 这一条链的链尾刚好没进内容对账，不能让 doctor 只字不提
            const filesystemFailure = isFileSystemErrorCode((error as NodeJS.ErrnoException).code);
            const detail = filesystemFailure
              ? describeSessionReadFailureReason(error)
              : error instanceof Error
                ? error.message
                : String(error);
            // 与 v0.1.278 的 open 同一口径：非文件系统错误（格式 / 库结构 / 适配器异常）下
            // 文件可能仍在，原生 resume 未必失败，不能断言「执行同样会失败」；doctor 能说的
            // 是「Watch 未能核对」。文件读不出来时才说很可能同样失败（第 365 轮）。
            warnings.push(
              filesystemFailure
                ? `链「${escapeControlChars(chain.name)}」的链尾会话内容解析失败（${tip.provider} ${tip.sessionId}）：${detail}；resume 与下次切换很可能同样失败——先修好这个文件（权限或内容），或 watch switch ${tip.provider} 重新绑定`
                : `链「${escapeControlChars(chain.name)}」的链尾会话内容解析失败（${tip.provider} ${tip.sessionId}）：${detail}；Watch 未能核对它的轮数与收尾状态，resume 与下次切换未必失败——以原生客户端的显示为准；若内容确实不完整，先从备份恢复该文件，或 watch switch ${tip.provider} 重新绑定`,
            );
          }
        }
      }
      // 本目录没有链时，本地库里别的目录的链是排障的关键线索：
      // 「本目录 0 条链」是结论，不指出它在哪就会被当成链丢了 / 没建成功
      let chainsElsewhere: ChainsElsewhere[] = [];
      if (!chains.length && deps.store.chainsElsewhere) {
        try {
          const rows = deps.store.chainsElsewhere(cwd);
          // 链按 --cwd 精确分组：同一个目录的另一种写法（软链、/var 与 /private/var）在这里
          // 也会落进「别处」。排障入口把那些说成「其它目录」会让人以为链丢了，标注出来
          const split = await splitElsewhereByDirectory(rows, cwd);
          chainsElsewhere = [
            ...split.sameDirectory.map((r) => ({ ...r, sameDirectory: true })),
            ...split.otherDirectories,
          ];
        } catch {
          // 补充说明而已：库读不出来时正文照常给，真正的库故障已由 listChains 那条处理
        }
      }
      // 与 `chainsElsewhere` 分开：那一档说「链在别的目录」，这一档说「链只活在上一条命令里」。
      // 两者都不成立时（真没建过链）一个字都不多说
      if (!chains.length && deps.ephemeralNote) warnings.push(deps.ephemeralNote);
      store = {
        available: true,
        ...(deps.storeCreated ? { created: true } : {}),
        chains: chains.length,
        activeChains: activeChains.length,
        chainsElsewhere,
        brokenTips,
        driftedPairs,
        emptyTips,
      };
    } catch (error) {
      const reason = describeStoreErrorReason(error);
      store = { available: false, error: reason };
      warnings.push(`本地库读取失败：${reason}`);
      failures.push('本地库读取失败');
    }
  }

  // 非链尾的「文件在、读不出来」会话：`storage` 的计数看不出这一档，`sessions` / `recent`
  // 早已会警告，doctor 作为排障入口不能说「claude 2 个会话」就完事——那两条 open / switch
  // 一读内容就失败。链尾已经在 brokenTips 里逐条说过（带链名与下一步），这里只报剩下的，
  // 同一份报告不把同一条文件讲两遍
  const tipFiles = new Set(store.available ? store.brokenTips.map((tip) => tip.filePath) : []);
  const unreadableBeyondTips = unreadableSessions.filter((item) => !tipFiles.has(item.filePath));
  // 与 sessions / recent 的 pushPreviewErrorWarning() 同一分档：0 字节是内容已经没了，
  // 「先确认这些文件可读（权限、路径）」对它不成立，照着做只会白检查一遍权限。
  // sessionId 来自各家存储（grok 目录名 / kimi 索引 / opencode TEXT 列），是不可信字符串；
  // 警告会原样进文本模式，必须在这里转义。reason 里可能嵌路径，同一档处理。
  const sample = (list: typeof unreadableBeyondTips): string =>
    list
      .slice(0, 3)
      .map((item) => `${escapeControlChars(item.provider)}:${escapeControlChars(item.sessionId)}（${escapeControlChars(item.reason)}）`)
      .join('、') + (list.length > 3 ? ` 等 ${list.length} 条` : '');
  const emptyFiles = unreadableBeyondTips.filter((item) => isEmptySessionFileReason(item.reason));
  const deniedFiles = unreadableBeyondTips.filter((item) => !isEmptySessionFileReason(item.reason));
  if (emptyFiles.length > 0) {
    warnings.push(
      `有 ${emptyFiles.length} 条会话文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${sample(emptyFiles)}；` +
        `列得出来，但 open / switch 读不出任何内容——内容补不回来，只能从备份恢复；没有备份就只能重新开一次会话（那是另一条会话）`,
    );
  }
  if (deniedFiles.length > 0) {
    warnings.push(
      `有 ${deniedFiles.length} 条会话文件读不出来（列得出来，但 open / switch 读内容时会失败）：${sample(deniedFiles)}；` +
        `先确认这些文件可读（权限、路径）再重试`,
    );
  }

  // 连归属都读不出来、因此一条目录列表里都不会出现的条目：不说就会被读成「这台机器上没有这条会话」，
  // 而它可能只是被截断，还能从备份恢复（open <id> 会说「找到了，但读不出来」，列表上却什么都没有）
  for (const stat of unattributableStats) {
    warnings.push(unattributableWarning(stat));
  }

  let imports: DoctorReport['imports'];
  if (!deps.importJobs) {
    imports = { available: false, error: deps.importJobsError ?? '导入日志目录不可用' };
  } else {
    try {
      const summary = await deps.importJobs.listSummary();
      const { items, skipped } = summary;
      // 注入的假实现可能还是旧形状：缺这一项时按「没有非常规条目」处理，不让 doctor 整段降级
      const ignored = summary.ignored ?? [];
      const count = (status: string) => items.filter((i) => i.status === status).length;
      imports = {
        available: true,
        total: items.length,
        imported: count('imported'),
        associated: count('associated'),
        uncertain: count('uncertain'),
        prepared: count('prepared'),
        // 「不要重试」只有配上 planId 才可执行
        uncertainIds: items.filter((i) => i.status === 'uncertain').map((i) => i.id).slice(0, 10),
        skipped: skipped.length,
        skippedJournals: skipped.slice(0, 10),
        ignored: ignored.length,
        // `--json` 保留原文（与其他结构化字段一致），转义 / 截断只在文本与警告里做
        ignoredEntries: ignored.slice(0, 10).map((e) => ({ name: e.name, reason: e.reason })),
      };
      if (imports.uncertain > 0) {
        warnings.push(`有 ${imports.uncertain} 个导入/关联计划结果未知（uncertain）：不要重试，也不要删除其执行日志`);
      }
      // 被跳过的日志不进 total：只报「共 N 条」会被读成「这些就是全部」，坏的那几份就此消失。
      // 原因已逐条在 skippedJournals 里，警告只给 id，别把同一段长文案印两遍
      if (imports.skipped > 0) {
        const ids = imports.skippedJournals.map((j) => j.id.slice(0, 8)).join('、');
        warnings.push(
          `有 ${imports.skipped} 份导入日志读不出来，已跳过（不计入上面的统计）：${ids}${imports.skipped > 10 ? ' 等' : ''}`,
        );
      }
      // 不是计划目录的条目同样不进 total：以前被静默跳过，doctor 的条数比目录里实际有的少，
      // 用户却看不出少掉的是什么。与 skippedJournals 同一口径：警告只点名，类型与原因已在
      // 逐条说明（`--json` 里是 `imports.ignoredEntries`）里给过，别把同一段长文案印两遍
      if (imports.ignored > 0) {
        const names = imports.ignoredEntries
          .map((e) => escapeControlChars(clipCodePoints(e.name, 40).text))
          .join('、');
        warnings.push(
          `导入日志目录里有 ${imports.ignored} 个条目不是计划目录，未计入统计：${names}${imports.ignored > 10 ? ' 等' : ''}；` +
            '各条目的类型与原因见逐条说明（--json 见 imports.ignoredEntries），不影响已有计划的 prepare / confirm / status，先确认来源再清理',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      imports = { available: false, error: message };
      warnings.push(`导入日志读取失败：${message}`);
    }
  }

  for (const p of providers) {
    if (p.error) {
      warnings.push(`${p.displayName} 检测失败：${p.error}`);
      failures.push(`${p.displayName} 检测失败（装了但起不来）`);
    }
  }

  // 体积读不出来同样是降级：静默给 null 等于「本地库这一栏什么都没有」，用户会以为没这项检查
  const storeFootprint = await probeStoreFootprint(environment.dbPath, deps.store);
  if (storeFootprint.error) warnings.push(`本地库体积读不全：${storeFootprint.error}`);

  const summary: DoctorSummary = {
    status: failures.length ? 'fail' : warnings.length ? 'warn' : 'ok',
    failures,
    warnings: warnings.length,
  };
  return {
    cwd,
    environment,
    providers,
    storage,
    store,
    imports,
    storeFootprint,
    claudeRetention,
    claudeProjectRetention,
    warnings,
    summary,
    ...(cwdProbe.state !== 'ok' ? { cwdState: cwdProbe } : {}),
  };
}
