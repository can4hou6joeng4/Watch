import { createReadStream } from 'node:fs';
import { lstat, open, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { escapeControlChars } from './display.js';

/**
 * 读文本；文件不存在按空串处理（新建分支依赖这个语义）。
 *
 * 其它读取失败（权限、路径是目录、I/O）必须抛出：调用方都是「读既有历史 → 追加/重写」的
 * 写入路径，把读失败当成空串会让后续写入用「只有新内容」覆盖掉原历史，且 round-trip
 * 校验只看新内容，查不出来。
 */
export async function readTextOrEmpty(filePath: string, label = '既有会话文件'): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    // 裸 errno（`EISDIR: illegal operation on a directory, read`）既看不出是哪个文件，
    // 也给不出下一步：与其它读取点统一走中文分档，并把路径（可能带控制字符）转义后带上
    throw new Error(
      `读取${label}失败：${describePathReadFailureReason(error)}（${escapeControlChars(filePath)}）；未写入，避免用空内容覆盖既有历史`,
    );
  }
}

export type TextHeadDetail = {
  /** 已按 UTF-8 解码的头部文本（末尾不完整字符被丢弃） */
  text: string;
  /** 实际读到的字节数（未解码前的原始窗口大小） */
  bytesRead: number;
  /** 文件是否比窗口更长。true 时 `text` 只覆盖文件开头一段，末尾可能停在半行 */
  truncated: boolean;
};

/**
 * 只读文件头部，最多 `maxBytes` 字节；返回文本**以及这段文本到底覆盖了多少**。
 *
 * 为什么需要它：会话文件可能大到超过 V8 的字符串上限（约 512 MB），`readFile(path, 'utf8')`
 * 会抛 `ERR_STRING_TOO_LONG`（旧注释写作「没有 code 的 `Invalid string length`」，第一百二十轮
 * 在 Node 24 上实测为带 code 的 `Error`，裸 `RangeError` 只是另一条路径），旧文案把它原样
 * 带出，于是「文件太大」被讲成「会话坏了，先修好它」。而「只要前几十行里的 cwd」这类需求
 * 根本不需要读完：只读头部既避开上限，也把一次几百 MB 的读取变成几 KB。
 *
 * `truncated` 是**诊断的依据**：没被截断才能断言「文件里就没有这个字段」；被截断时只能说
 * 「窗口里没有」。调用方不能只拿 `text` 然后按固定行数去描述覆盖范围——那会把「只查了
 * 窗口内 N 行」讲成「查过前 60 行」。
 *
 * 不在字节中间截断 UTF-8 字符：`StringDecoder` 会缓冲不完整的多字节序列，末尾最多丢一个
 * 字符——对「取 cwd 字段 / 判首行」这类用途无损。文件短于 `maxBytes` 时全部返回。
 */
export async function readTextHeadDetail(filePath: string, maxBytes: number): Promise<TextHeadDetail> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, maxBytes));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    // 读满窗口时再探一个字节：恰好等于上限但与文件等长的情形不能算截断
    let truncated = false;
    if (total === buffer.length && total > 0) {
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(probe, 0, 1, total);
      truncated = bytesRead > 0;
    }
    return { text: decodeUtf8Head(buffer.subarray(0, total)), bytesRead: total, truncated };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 只要文本时的兼容包装；需要判断覆盖范围（诊断文案）时用 `readTextHeadDetail()`。 */
export async function readTextHead(filePath: string, maxBytes: number): Promise<string> {
  return (await readTextHeadDetail(filePath, maxBytes)).text;
}

/** 解 UTF-8 头部；末尾可能被截断的多字节序列按丢弃处理，不产生替换字符。 */
function decodeUtf8Head(bytes: Buffer): string {
  // 从末尾往回数续字节，定位最后一个字符的起始位置。**扫描时不要移动截断点**：
  // 先按续字节数把 end 减下去，再发现这个字符其实完整，就会把一个完整字符白白丢掉。
  let cut = bytes.length;
  let i = cut - 1;
  let continuations = 0;
  while (i >= 0 && continuations < 4 && (bytes[i] & 0b1100_0000) === 0b1000_0000) {
    i -= 1;
    continuations += 1;
  }
  if (i >= 0) {
    const lead = bytes[i];
    const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    // 已经读到的字节不够组成一个字符：从它的起始字节起整体丢弃
    if (cut - i < needed) cut = i;
  }
  return bytes.subarray(0, cut).toString('utf8');
}

/**
 * 流式逐行读取文本文件（含最后一行不以换行结尾的情况）。
 *
 * 为什么需要它：会话文件可以大到超过 V8 的字符串上限（约 512 MB），`readFile(path, 'utf8')`
 * 直接抛超限错误（`ERR_STRING_TOO_LONG`）——本机实测有一条 695 MB 的 Claude 会话，`parse` 因此
 * 完全读不了它。逐行流式读取既没有整份字符串的天花板，也把峰值内存从「整个文件」
 * 降到「一行」。
 *
 * 错误照原样抛出（保留 `ENOENT` / `EACCES` 等 code），调用方沿用既有的中文分档：
 * 这里不替上层决定「读不出来」该怎么讲。`readline` 的 `'error'` 会经 async 迭代抛出，
 * 不需要额外监听器（与 `createInterface` 同步用法不同）。
 */
export async function* iterateFileLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // `crlfDelay: Infinity` 已把 `\r\n` 归一成 `\n`，这里只需去掉行尾可能残留的 `\r`
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * 路径不存在（`ENOENT` / `ENOTDIR`）。
 *
 * 全局反查（`findById`）把扫描根目录的失败当异常抛出，是为了不把权限 / I/O 问题讲成
 * 「这个会话不存在」；但原生会话根目录在从未用过该 Agent 的机器上本来就不存在，
 * 那是正常事实、不是故障。两者都返回 `null`/空结果时，用户看到的才是干净的「没找到」。
 */
export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 只读路径（用量统计、摘要）读取失败时的中文说明：按 errno 分开说。
 *
 * 只有 `ENOENT` / `ENOTDIR` 能说「已不存在」，`EACCES` / `EPERM` 是权限问题（先修权限，
 * 不要去重新绑定或换会话），其余带上 code / 原文。读不出来不等于「这家原生没有这项数据」。
 */
export function describeSessionReadFailure(filePath: string, error: unknown): string {
  return `${describeSessionReadFailureReason(error)}：${escapeControlChars(filePath)}`;
}

/**
 * 同上，但不带路径。调用方已经在前文给过路径时用它，避免同一句话里出现两次路径
 * （`watch doctor` 的「链尾会话文件状态无法确认：<路径>；<原因>」就是这种）。
 */
export function describeSessionReadFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return '会话文件已不存在';
  if (code === 'EACCES' || code === 'EPERM') return '会话文件无权读取（权限问题，不是被删除）';
  if (isOversizedStringError(error)) return '会话文件太大，超过单次读入的上限（文件本身完好，不是被损坏）';
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `会话文件读不出来（${reason}）`;
}

/**
 * 「路径 / 目录读不出来」的简要中文原因，用来拼在「无法读取 X 目录 <路径>：<原因>」这类消息里。
 *
 * 与 `describeSessionReadFailureReason()` 的区别：这里不假定对象是会话文件（可能是目录、
 * 数据库、索引），措辞按路径来说，避免把「读不出目录」讲成「会话文件读不出来」。
 * 适配器以前直接把 `error.message` 拼进用户面文案，`sessions` / `recent` / `doctor` 的
 * warnings 里就会出现 `EACCES: permission denied, scandir '…'` 这类英文原文。
 */
export function describePathReadFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return '路径不存在（可能刚被移动或删除）';
  if (code === 'EACCES' || code === 'EPERM') return '无权读取（权限问题，不是路径写错）';
  if (code === 'EISDIR') return '该路径是目录，不是文件';
  if (isOversizedStringError(error)) return '文件太大，超过单次读入的上限（不是文件损坏）';
  if (code) return `读取失败（${code}）`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「整份读成字符串时超过 V8 字符串上限」的错误。
 *
 * 第一百二十轮实测（Node 24）：`readFile(path, 'utf8')` 对约 520 MB 的文件抛
 * `Error: Cannot create a string longer than 0x1fffffe8 characters`，`code` 是
 * `ERR_STRING_TOO_LONG`——**不是**以往注释里说的「没有 code 的 `Invalid string length`」；
 * `readFileSync` 报的是同一句。也就是说，旧文案会走到「读取失败（ERR_STRING_TOO_LONG）」，
 * 用户既看不出「文件本身是好的」，也不知道下一步是改用流式读取而不是修文件。
 *
 * 兜底也认 `RangeError` + `Invalid string length`：不同 Node 版本 / `Buffer.toString` 路径
 * 可能走那一句，且它没有 code，`describe*()` 会把它原样当英文吐给用户。
 */
function isOversizedStringError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ERR_STRING_TOO_LONG') return true;
  return error instanceof RangeError && /Invalid string length/i.test(error.message);
}

/**
 * Node 文件系统错误的 `code`（`EACCES` / `EISDIR` / `EIO`…）。
 *
 * 用来区分「文件读不出来」与「文件读出来了但内容解析不了」：前者要说权限 / 路径，
 * 后者才该说内容。只认 `E` + 大写的形状，别把适配器自己造的错误码（如 `parse_failed`）误判成 fs 错误。
 */
export function isFileSystemErrorCode(code: unknown): code is string {
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
}

/**
 * 「读不出来」的原因：文件系统错误按 errno 说中文，其余保留适配器 / 业务自己的说明。
 *
 * `parse` / `sessionUsage` / `listSessions` 既可能因权限 / 路径抛 fs 错误（原文是
 * `EACCES: permission denied, open '…'`），也可能自己抛出已经写好的中文错误（格式坏、
 * 库打不开）。统一走这里，就不会出现「把权限问题讲成格式问题」或半句英文 errno。
 */
export function describeReadFailureOrSelf(error: unknown): string {
  return isFileSystemErrorCode((error as NodeJS.ErrnoException).code)
    ? describeSessionReadFailureReason(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

export type SessionFilePresence =
  // `size` 只在 present 时给出：调用方要在「文件在、是普通文件」之后继续区分
  // 「有内容」与「0 字节（内容已丢失）」，不必为了一个字节数再 stat 一次
  | {
      state: 'present';
      isFile: boolean;
      size?: number;
    }
  // `compressed`：原路径 stat 不到、但同名 `.jsonl.zst` 是非空普通文件（Codex 的
  // `local_thread_store_compression` 压缩后删掉普通副本）。不是「会话丢了」，是「只剩压缩格式」。
  // `emptyCompressed`：同名 `.jsonl.zst` 是 0 字节普通文件——副本还在原处，但内容已丢失。
  // 两者都让原路径处于 missing；下一步完全不同，不能合成一句「文件已不存在」。
  | { state: 'missing'; compressed?: string; emptyCompressed?: string }
  | { state: 'unknown'; reason: string };

/**
 * 原路径缺失时只读探一次同名 `.jsonl.zst`。
 *
 * Codex 会把闲置 rollout 压成 `<原名>.jsonl.zst` 并删除普通副本（上游固定提交
 * `ee344ca9458351a6ea102795fa73110ad3ede5dc` 的 `compression.rs`）。Watch 本版不读压缩格式，
 * 但「原路径 stat 不到」与「会话被删了」是两件事：前者文件还在、原生继续该会话就会展开回 `.jsonl`。
 * 只 `lstat` 一次，不解压、不打开、不改动；符号链接不算（与扫描侧「只识别普通文件」一致）。
 *
 * 0 字节的 `.zst` 仍要返回（`empty: true`）：它不是可用副本，但也不是「没有」——文件就在
 * 原处，说成「已不存在」会让人连同备份线索一起删掉，说成「继续会话会展开」又是假承诺。
 */
async function compressedSibling(filePath: string): Promise<{ path: string; empty: boolean } | undefined> {
  const compressedPath = `${filePath}.zst`;
  try {
    const info = await lstat(compressedPath);
    if (!info.isFile()) return undefined;
    return { path: compressedPath, empty: info.size === 0 };
  } catch {
    return undefined;
  }
}

/** `missing` 且找到压缩副本时的说明与下一步；没有压缩副本返回 `null`（调用方沿用自己的「已不存在」）。 */
export type CompressedCopyNote = {
  /** 副本形态：`intact` 可让原生重新展开；`empty` 是 0 字节，内容已丢失 */
  kind: 'intact' | 'empty';
  /** 嵌进「会话文件${note}」这类句子的说明（不含下一步动作） */
  note: string;
  /** 下一步该做什么，**不含**「再重试」等各调用点自补的动作 */
  advice: string;
};

/**
 * `missing` 且找到同名 `.jsonl.zst` 时的说明与下一步；没有压缩副本返回 `null`。
 *
 * 只说「文件已不存在」会把人引去重新绑定 / 重建历史，而它其实还在、只是本版不读压缩格式。
 * 0 字节副本是第三种状态：文件还在，内容却已经没了——这时「让原生展开」是假承诺，只能备份恢复
 * 或重开会话；把下一步和说明放在同一个返回值里，调用点就不会只取说明、又补一句错的建议。
 */
export function compressedCopy(presence: SessionFilePresence): CompressedCopyNote | null {
  if (presence.state !== 'missing') return null;
  if (presence.emptyCompressed) {
    return {
      kind: 'empty',
      note: `只剩一个 0 字节的同名压缩副本 ${escapeControlChars(presence.emptyCompressed)}（内容已丢失，重新展开也拿不回内容）`,
      advice: '从备份恢复或重新开一次会话',
    };
  }
  if (!presence.compressed) return null;
  // 不把「Codex」当事实：`.zst` 也可能是用户自己归档的。压缩语义只在 Codex 成立时给出，
  // 同时用「副本完好时」限定——这里只 stat 过一次，不打开、不解压，无法保证内容可解。
  return {
    kind: 'intact',
    note:
      `已被压缩为 ${escapeControlChars(presence.compressed)}（本版不读压缩格式，原 .jsonl 不在；` +
      `若是 Codex 的本地线程压缩且副本完好，在 Codex 里继续该会话会重新展开为 .jsonl，之后 Watch 即可读到；` +
      `不要直接删除或改名）`,
    advice: '先让它重新展开',
  };
}

/**
 * 「调用方接下来要重试同一操作」时的下一步。0 字节副本重开多少次会话都还是同一条路径 /
 * 同一份链绑定——重开得到的是另一条会话，必须先恢复备份；完好副本则先让原生展开。
 * `retry` 由调用点给（「再重试」「再重跑 watch doctor」），因为各命令的重试动词不同。
 */
export function compressedRetryAdvice(copy: CompressedCopyNote, retry: string): string {
  return copy.kind === 'empty' ? `从备份恢复后${retry}` : `${copy.advice}，${retry}`;
}

/**
 * `stat` 一次会话文件，判断它「确实不在了」还是「只是读不出来」。
 *
 * 只有 `ENOENT` / `ENOTDIR` 是 missing；`EACCES` / `EIO` 等返回 unknown 并给出原因，
 * 调用方必须把这类当成「状态无法确认」，不能讲成「文件已被删除」——否则权限问题
 * 会被读成会话丢了，人会去重新绑定或重建，而不是修权限。
 */
export async function sessionFilePresence(filePath: string): Promise<SessionFilePresence> {
  try {
    const info = await stat(filePath);
    return { state: 'present', isFile: info.isFile(), size: info.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      const sibling = await compressedSibling(filePath);
      if (!sibling) return { state: 'missing' };
      return sibling.empty
        ? { state: 'missing', emptyCompressed: sibling.path }
        : { state: 'missing', compressed: sibling.path };
    }
    return { state: 'unknown', reason: describeSessionReadFailure(filePath, error) };
  }
}

/**
 * 「这条会话是空的（0 字节）」的说明。`probeSessionReadable()`、各家预览与 cwd 解析共用同一句，
 * 不想在四五个地方各写一遍——措辞不一致时同一个状态在 `open` / `sessions` / `doctor` 上会有三种说法。
 *
 * 0 字节不是「这条会话还没有内容」：进程被杀 / 只写了一半 / 磁盘满都会留下这种文件，而合法的
 * 空会话（`new` 建出来的）每家都写了占位内容，不会是 0 字节（见 `src/providers/CLAUDE.md`）。
 */
export function describeEmptySessionFile(filePath: string, subject = '会话文件'): string {
  return `${subject}是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${escapeControlChars(filePath)}`;
}

/**
 * 已经拿到 `stat` 结果的路径用：这个会话文件是不是「空的」。
 *
 * claude / codex / kimi 的预览都要把会话文件读一遍，0 字节在那里顺手就能发现（`raw.length === 0`）。
 * pi / grok 的预览不读会话内容——pi 干脆没有预览，grok 的标题来自 `summary.json`——于是
 * **同一个状态在 `open` 与 `sessions` 上说法相反**：`open` 会说「会话文件是空的…内容已丢失」，
 * 列表与 `doctor` 却把这条会话算成正常的一条、`warnings` 一个字都没有。判据放在这里，
 * 两家的列表在已经拿到的 `stat` 上判一次即可，不必各写一句（措辞分叉正是本文件开头要避免的）。
 *
 * `chainUsage()` 用的是同一条：`sessionUsage` 对 0 字节文件返回 `null`，与「这家原生没有
 * usage 字段」逐字相同，只有在 `sessionFilePresence()` 给出的 `stat` 上再判一次大小，才能
 * 把「内容已丢失」从「没有用量数据」里分出来。
 *
 * 只按 `isFile() && size === 0` 判：目录 / 设备文件走 `sessionFilePresence()` 那一档，
 * 两处不重复下结论；`size` 缺省（调用方没拿到）时不判成空。
 *
 * `subject` 缺省是「会话文件」；用量来自旁路文件时改传「用量数据源」（`usageSidecarProblem()`），
 * 免得同一句 0 字节文案在别处被复制出第二份（`isEmptySessionFileReason()` 仍只认前者）。
 */
export function emptySessionFileReasonFromStat(
  info: { isFile(): boolean; size?: number },
  filePath: string,
  subject = '会话文件',
): string | undefined {
  return info.isFile() && info.size === 0 ? describeEmptySessionFile(filePath, subject) : undefined;
}

/**
 * 这条原因是不是「会话文件是空的」那一档。
 *
 * 0 字节与读不出来（权限、路径）都会进 `previewError` 与 doctor 的 unreadable 汇总，但下一步
 * 相反：权限要修权限，空文件的内容已经没了，只能重新开一次会话或从备份恢复。警告文案按它分档。
 */
export function isEmptySessionFileReason(reason: string): boolean {
  return reason.includes('会话文件是空的');
}

/**
 * 只读探一次「这个会话文件现在读得出来吗」：`open` 一下外加一次 `fstat`，不读内容。
 *
 * `stat` 成功不代表读得出来（`chmod 000` 的文件 `stat` 照常返回），所以只 `stat` /
 * 只列目录的路径（如 `adopt` 写链记录）会显得一切正常，而它打印的 resume 命令
 * 一执行就失败。返回 `null` 表示读得出来，否则是中文原因（已带路径）。
 *
 * **`open` 成功也不代表有内容可恢复**：进程被杀 / 只写了一半 / 磁盘满时，会话文件会被
 * 截成 0 字节，`open` 依然成功。claude / codex / pi 的 cwd 来自文件内容，`findById` 会报
 * 「找到了，但读不出来：…（会话文件是空的…）」；grok 的 cwd 来自目录名、kimi 来自索引，
 * 一条 0 字节的文件照样反查得到，`open` 的四条分支（摘要、`--from` 的来源与目标、
 * `--to` 同家快路径、`--to` 的空来源）得自己探这一下。`switch` 的链尾、`new` 的同家拒绝、
 * `status` 的链尾与 tips、`chain list` 的 tip、`doctor` 的 pathPresence、`adopt` 也共用它；
 * 漏了任何一处都会替一条空文件宣称「可以直接打开」。判据放在这里而不是各调用点各写一遍。
 */
export async function probeSessionReadable(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    // 只有普通文件才按字节数判；目录 / 设备文件走原来的「打得开就算读得出」，
    // 它们的「不是普通文件」由 sessionFilePresence() 单独说，两处不重复下结论
    if (info.isFile() && info.size === 0) {
      return describeEmptySessionFile(filePath);
    }
    return null;
  } catch (error) {
    // 这里只报「读不出来」：文件确实不在时也要说清，否则用户会去反复试 resume
    if (isMissingPathError(error)) return `会话文件已不存在：${escapeControlChars(filePath)}`;
    return describeSessionReadFailure(filePath, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}
