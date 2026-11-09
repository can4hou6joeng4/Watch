// `--cwd` 指向的路径是否有问题：各 provider 的 listSessions / findLatestSession 按原生记录的
// 路径字符串精确比较，路径错了只会安静返回 0，看起来像「这个目录没有会话」。查询类命令与
// `watch doctor` 统一用这里的说明做披露，避免同一个坑每处各写一份文案。
import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { escapeControlChars, hasControlChars } from './display.js';
import { normalizePath } from './platform.js';

/**
 * 一个目录现在能不能用。分开说「不存在」与「读不出来」是因为两者下一步完全不同：
 * 前者要恢复 / 改正路径，后者是权限问题，改路径只会白折腾一遍。
 * `not-directory` 是 `stat` 成功但对象不是目录（被同名文件占住）；`missing` 包含 `ENOTDIR`
 * （路径上某一级是文件），对调用方而言都是「这个目录进不去」。
 */
export type CwdInspection =
  | { state: 'ok' }
  | { state: 'not-directory' }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'unknown'; reason: string };

/** 只回答「这个目录能不能进、为什么不能」，文案由调用方按自己的语境拼。 */
export async function inspectCwd(cwd: string): Promise<CwdInspection> {
  try {
    const probe = await stat(cwd);
    return probe.isDirectory() ? { state: 'ok' } : { state: 'not-directory' };
  } catch (error) {
    // 只有 ENOENT / ENOTDIR 才能说「不存在」：EACCES 等读不出来时要说清是权限，
    // 否则权限问题会被讲成路径写错，用户会去改路径而不是修权限
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'denied' };
    return { state: 'unknown', reason: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * 路径放进用户可见文案时的统一处理。
 *
 * 路径与链名、会话预览一样是**不可信输入**：`--cwd` 是用户手输 / 从别处粘贴的，链记录里的
 * `cwd` 是从本地库读回来的（它当初也来自 `--cwd` 或原生会话文件）。2026-11-09 实测（修复前，
 * 隔离 HOME，文本模式）：
 *
 *   $ watch chain new ESC1 --cwd $'<proj>\e[31mRED'
 *   [watch] --cwd 目录不存在：…/probe310/proj^[[31mRED；链「ESC1」已经按这个路径写进本地库…
 *
 * ESC 序列**真的进了终端**（能改颜色、改标题、清屏）；换成 `$'<proj>\n'` 时，换行把那条警告
 * 折成两行，后半句「各 provider 按原生记录的路径字符串精确比较」看着像独立的一句话。
 * 这与 `escapeControlChars()` 修链名 / 会话预览时是同一件事（见 `src/core/display.ts` 的头注释），
 * 只是路径这一路当时漏了：`--json` 里的 `cwd` 字段由 `JSON.stringify` 转义、不会注入终端，
 * 而**文案里的路径**是直接拼进 stdout / stderr 的。
 *
 * 只转义、不改路径：`--cwd` 不 `trim()`（目录名允许首尾空白，与链名 / 会话 id 那种「写入侧
 * 从不产生首尾空白」的标识符不同），也不替用户猜「真正的目录」。
 */
export function showPathInMessage(path: string): string {
  return escapeControlChars(path);
}

/**
 * `--cwd` 里**真有**控制字符时补的一句。
 *
 * 只把字符转义还不够：用户看到 `\n` / `\u001B` 会以为是 Watch 打印了什么怪东西，而问题是
 * 自己的输入里混进了换行 / 制表符 / ESC（复制粘贴最常见）。这句话说明「哪些字符被转义了」
 * 与「下一步怎么办」，且不假定那串控制字符一定不是目录名的一部分——目录名里真可以有它们。
 */
export function cwdControlCharsNote(cwd: string): string {
  if (!hasControlChars(cwd)) return '';
  return (
    '；--cwd 的取值里有控制字符（换行、制表符、ESC 等，多来自复制粘贴），上面显示时已转义成 ' +
    '\\n / \\u001B 这类可见形式——不要把换行 / 制表符一起粘进来，把 --cwd 写成一个普通目录路径重试' +
    '（若这个目录名里确实含控制字符，只能改用另一条不含它的路径，或先给目录改名）'
  );
}

/**
 * 查询类命令（`status` / `sessions` / `recent` / `search` / `usage` / `chain list`）的口径：
 * 路径不对时各 provider 只会安静返回 0 条，所以要说清「下面的 0 不代表目录里真没有会话」。
 */
export function describeCwdProblem(probe: CwdInspection, cwd: string): string | null {
  // 说「不会列出任何会话」而不是「会全部显示 0」：链按 `--cwd` 原字符串分组、不依赖目录是否存在，
  // 于是 `chain new` 在不可用目录上建出的那条链，`status` / `chain list` 带同一个 `--cwd` 照样列得出来
  // （2026-11-09 实测）。原来的说法不只是过头，用户还会在同一份输出里看到「全部显示 0」与一条链并存。
  const tail = '各 provider 按原生记录的路径字符串精确比较，路径不对时不会列出任何会话';
  const shown = showPathInMessage(cwd);
  const note = cwdControlCharsNote(cwd);
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `--cwd 指向的不是目录：${shown}；会话与链都按路径精确匹配，结果不代表任何真实项目${note}`;
    case 'missing':
      return `--cwd 目录不存在：${shown}；${tail}${note}`;
    case 'denied':
      return `--cwd 目录无权访问：${shown}（权限问题，不是路径写错）；${tail}${note}`;
    case 'unknown':
      return `--cwd 目录无法访问：${shown}（${probe.reason}）；${tail}${note}`;
  }
}

/**
 * 写入口径（`watch new` / `watch chain new`）：这里没有任何列表参与，后果不是「显示 0」，而是
 * **真的在原生存储 / 本地库里写入了绑定到这个目录的东西**（`new` 是一个会话文件，`chain new`
 * 是一条链记录），随后打印的 `resume` 命令与后续查询都会撞上这个进不去的目录。所以不带上
 * 「不会列出任何会话」那句——复用它会让用户以为这只是一次「查不到」，而实际已经写进去了东西。
 * 只给出原因前半句，具体后果由调用方补（`new` 要等会话建出来才知道文件路径，`chain new` 要
 * 等链记录建出来才知道链名）。
 */
export function describeWriteCwd(probe: CwdInspection, cwd: string): string | null {
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `--cwd 不是目录（被同名文件占住了）：${showPathInMessage(cwd)}${cwdControlCharsNote(cwd)}`;
    case 'missing':
      return `--cwd 目录不存在：${showPathInMessage(cwd)}${cwdControlCharsNote(cwd)}`;
    case 'denied':
      return `--cwd 目录无权访问：${showPathInMessage(cwd)}（权限问题，不是路径写错）${cwdControlCharsNote(cwd)}`;
    case 'unknown':
      return `--cwd 目录无法访问：${showPathInMessage(cwd)}（${probe.reason}）${cwdControlCharsNote(cwd)}`;
  }
}

/** 路径有问题时返回一句可直接输出的说明；正常目录返回 null（不做符号链接 / realpath 归因）。 */
export async function cwdProblem(cwd: string): Promise<string | null> {
  return describeCwdProblem(await inspectCwd(cwd), cwd);
}

/**
 * `--cwd` 是**同一个目录的另一种写法**时的说明（路径本身没问题，`cwdProblem()` 返回 null）。
 *
 * 各 provider 按原生记录的路径字符串精确比较，于是同一个目录换个写法就一条会话都查不到：
 * 软链接（`/tmp/x` 与 `/private/tmp/x`、指向同一项目的 `~/work`）与大小写不同的写法都是同一件事。
 * `watch doctor` 早就有这条（它自己 `stat` + `realpath`，且只在「六家一共扫不到任何会话」时给出），
 * 而 `status` / `sessions` / `recent` 在零结果时只留一句「未发现会话」——排障入口与查询入口两种口径，
 * 用户会去重开一次会话，而不是换路径重查。
 *
 * 只在调用方**已经确认零结果**时才调：健康目录每次查询都多一遍 realpath 是白花，也多一句噪音。
 * 目录不存在 / 进不去时返回 null——那是 `cwdProblem()` 的活，两句话叠在一起会互相干扰。
 * `scannedIncomplete` 非空时也返回 null：这时零结果是「有几家压根没读成」造成的，与路径写法无关，
 * 换一个写法重试解决不了权限 / 库的问题，先给下一步会把人引到错误的方向（原因由调用方自己披露）。
 * 文案不提「符号链接」这一个原因：`/var` 与 `/private/var` 这类**前缀**是软链、名字大小写不同则是
 * 文件系统语义，两者表现完全一样（会话一条都查不到），说错原因会把人引去 `ls -l` 一个本来正常的目录。
 */
export async function cwdAliasHint(
  cwd: string,
  knownSpelling?: string,
  /** 这次压根没读成的 provider id：零结果不能据此归因到「写法不对」 */
  scannedIncomplete?: readonly string[],
): Promise<string | null> {
  if (scannedIncomplete?.length) return null;
  let real: string;
  try {
    const probe = await stat(cwd);
    if (!probe.isDirectory()) return null;
    real = await realpath(cwd);
  } catch {
    // 不存在 / 读不出来：cwdProblem() 已经说过，这里不重复
    return null;
  }
  if (real === cwd) return null;
  // 调用方从本地库 / 搜索索引里已经知道「这个目录的另一种写法具体是什么字符串」时用那一份：
  // 链与索引都是按那个字符串精确匹配的，realpath 未必查得到（records 里存的是当时的 cwd）
  const target = knownSpelling ?? real;
  const hedge = knownSpelling ? '' : '（若会话 / 链是在同一目录的另一个写法下建的，就用那个写法）';
  return (
    `--cwd 指向的目录还有另一种写法（realpath: ${showPathInMessage(real)}），而本目录没扫到任何会话；` +
    '各 provider 按原生记录的路径字符串精确比较，同一个目录换个写法（符号链接、/var 与 /private/var 这类前缀、大小写）就会一条都查不到' +
    `——把 --cwd 换成 ${showPathInMessage(target)} 重试同一条命令${hedge}；其余参数照旧` +
    cwdControlCharsNote(target)
  );
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return normalizePath(await realpath(target));
  } catch {
    // 不存在 / 读不出来：不能据此断言「是同一个目录」，调用方退回原串比较
    return null;
  }
}

/**
 * 两个路径字符串是不是指向**同一个目录**（同步版，供必须在同步 API 里给结论的地方用）。
 *
 * 「属于另一个目录」是一句断言：链与链尾会话都按 `--cwd` 的**原字符串**记录，`--cwd` 只是
 * 同一个目录的另一种写法（软链、`/var` 与 `/private/var` 这类前缀、大小写）时，那句话就是错的。
 * `Store.missingChainMessage()` 与 `cmdAdopt` 都在同步上下文里（前者是 `Store` 方法、后者在
 * `catch` 里直接拼文案），所以给一份同步实现，而不是把它们改成异步。
 *
 * 只调 `realpathSync`、不碰别的：两者都能解析时才敢说「同一个目录」；读不出来退回 `normalizePath`
 * 的字符串比较——读不出来不能反过来讲成「就是同一个」。
 */
export function sameDirectorySync(a: string, b: string): boolean {
  try {
    return normalizePath(realpathSync(a)) === normalizePath(realpathSync(b));
  } catch {
    return normalizePath(a) === normalizePath(b);
  }
}

/**
 * 把「本目录之外」的记录（本地库里的链、搜索索引里的命中）按**真实路径**分成两类。
 *
 * 「本目录没有链，但本地库里还有属于其它目录的链」这句话在 `--cwd` 只是同一个目录的另一种
 * 写法（软链接、`/var` 与 `/private/var` 这类前缀）时是错的：链就在这个目录里，只是字符串
 * 写法不同，用户照「其它目录」去理解会以为项目根本没有链，甚至在本目录再建一条重复的。
 * 2026-11-09 实测（隔离 HOME，链建在 `<tmp>/real`、用 `<tmp>/link` 软链查询）：
 * `watch chain list --cwd <link>` 回「本目录没有链，但本地库里还有属于其它目录的链…：<tmp>/real」，
 * `watch usage --cwd <link>` 的 `notes` 同样是这一句——两处都在**断言事实**，而事实是同一个目录。
 *
 * 只比较 `realpath`，不改动任何查询结果：读不出来时退回原串比较（读不出来不能讲成「同一个目录」）。
 * `realpath` 输出与建议里给出的目录都取**记录里的原写法**，因为链与索引都是按那个字符串精确匹配的。
 */
export async function splitElsewhereByDirectory<T extends { cwd: string }>(
  rows: T[],
  cwd: string,
): Promise<{ sameDirectory: T[]; otherDirectories: T[] }> {
  if (!rows.length) return { sameDirectory: [], otherDirectories: [] };
  const real = await safeRealpath(cwd);
  const sameDirectory: T[] = [];
  const otherDirectories: T[] = [];
  for (const row of rows) {
    const rowReal = await safeRealpath(row.cwd);
    const same = real && rowReal ? real === rowReal : normalizePath(row.cwd) === normalizePath(cwd);
    (same ? sameDirectory : otherDirectories).push(row);
  }
  return { sameDirectory, otherDirectories };
}

/**
 * 会话记录里的工作目录还能不能进。
 *
 * `open` 返回的 `cd … && <resume>` 与原生 resume 都在这个目录里执行；目录被删 / 被移动后，
 * 会话内容本身读得出来、转入也照样写成功，但命令会在第一步 `cd` 就失败。以前这种情况
 * 只有一句成功的 resume 命令，用户会以为是 CLI 或会话坏了。原因按 errno 分开说：
 * 权限问题不是「被删除」，别把人引去重建目录。
 */
export async function sessionCwdProblem(cwd: string): Promise<string | null> {
  const probe = await inspectCwd(cwd);
  const shown = showPathInMessage(cwd);
  const note = cwdControlCharsNote(cwd);
  const tail = '下面的 cd 命令会在这里失败——先恢复这个目录，或手动 cd 到新位置再执行 resume 命令';
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `会话记录的工作目录不是目录（被同名文件占住了）：${shown}；下面的 cd 命令会失败——先让这个路径重新成为目录${note}`;
    case 'missing':
      return `会话记录的工作目录已不存在：${shown}（项目可能被移动或删除）；${tail}；会话内容本身仍可读取 / 转入${note}`;
    case 'denied':
      return `会话记录的工作目录无权访问：${shown}（权限问题，不是被删除）；${tail}${note}`;
    case 'unknown':
      return `无法确认会话记录的工作目录能否进入：${shown}（${probe.reason}）；${tail}${note}`;
  }
}
