import type { ProviderAdapter } from '../providers/adapter.js';
import { escapeControlChars } from './display.js';

/**
 * 「连目录归属都读不出来」的会话统计（见 `ProviderAdapter.unattributable`）。
 *
 * 这一档与另外三档互不替代：`previewError` 是「列出来了但内容读不出来」；`storage.unreadable`
 * 是「知道 id 与路径但打不开」；`unavailable` 是「这一家整片没读成」；而这里是「归属那一行坏了，
 * 所以它连属于哪个目录都不知道」——它不会出现在**任何**目录的列表里，却真实存在。
 *
 * 文案以前只在 `watch doctor` 里（2026-11-09 第 286 轮），而用户最常看的是 `sessions` /
 * `recent` / `status` 这三张列表：Doctor 说得清、列表说得像「这个目录就这么多会话」，同一件事
 * 两套口径。现在三个列表入口与 doctor 共用本模块的文案，改口径只改一处。
 */
export type UnattributableStat = {
  provider: string;
  displayName: string;
  count: number;
  samples: string[];
  /** 归属写在哪一行（如 Codex 的 `session_meta` 首行）；缺省时用通用说法 */
  summary?: string;
  /** 覆盖默认的「归属元数据缺失或损坏」原因（例如 Codex 的 `.jsonl.zst` 压缩副本） */
  cause?: string;
  /** 覆盖默认的「可能是被截断，能从备份恢复就别直接删」建议；压缩副本不是损坏，不能沿用 */
  advice?: string;
  /**
   * 读不出来的容器位置（如 Kimi 的工作区分组目录）。
   * `count` 只数会话文件；一个分组里可能有 0 到几十条会话，混进同一个数字会少报，
   * 也会让共用文案把目录路径叫成「会话文件」，所以单独一档。
   */
  locations?: { description: string; count: number; samples: string[] }[];
};

const DEFAULT_CAUSE = '会话归属的元数据缺失或损坏';
const DEFAULT_ADVICE = '先确认这些文件的内容（可能是被截断），能从备份恢复就别直接删';

/** 原因与建议两句话按家覆盖，缺省沿用「<summary>缺失或损坏」的旧文案 */
function causeAdvice(stat: UnattributableStat): { cause: string; advice: string } {
  const fallback = stat.summary ? `${stat.summary}缺失或损坏` : DEFAULT_CAUSE;
  return { cause: stat.cause ?? fallback, advice: stat.advice ?? DEFAULT_ADVICE };
}

function locationCount(stat: UnattributableStat): number {
  return (stat.locations ?? []).reduce((sum, l) => sum + l.count, 0);
}

/** 「另有 N 个工作区分组读不出来（里面可能还有会话）」一句；没有位置故障时 `null` */
function locationsText(stat: UnattributableStat): string | null {
  const locs = (stat.locations ?? []).filter((l) => l.count > 0);
  if (!locs.length) return null;
  const parts = locs
    .map((l) => (l.description === 'Kimi 会话目录' ? 'Kimi 会话目录本身' : `${l.count} 个${l.description}`))
    .join('、');
  const samples = locs
    .flatMap((l) => l.samples)
    .slice(0, 3)
    .map((x) => escapeControlChars(x))
    .join('、');
  return `另有 ${parts}读不出来（里面可能还有若干会话）${samples ? `：${samples}` : ''}`;
}

/** 逐家问一次；未实现的跳过，抛错的也跳过（那已由本家 `listSessions` 的失败通道说过） */
export async function collectUnattributable(
  adapters: readonly ProviderAdapter[],
): Promise<UnattributableStat[]> {
  const stats: UnattributableStat[] = [];
  for (const adapter of adapters) {
    if (!adapter.unattributable) continue;
    try {
      const result = await adapter.unattributable();
      const locations = (result.locations ?? []).filter((l) => l.count > 0);
      if (result.count <= 0 && locations.length === 0) continue;
      stats.push({
        provider: adapter.id,
        displayName: adapter.displayName,
        count: result.count,
        samples: result.samples,
        ...(result.summary ? { summary: result.summary } : {}),
        // 家自定义的原因 / 建议要原样带到文案层，否则压缩副本会落回「元数据损坏」的默认句
        ...(result.cause ? { cause: result.cause } : {}),
        ...(result.advice ? { advice: result.advice } : {}),
        ...(locations.length ? { locations } : {}),
      });
    } catch {
      // 整体读不出来时 `listSessions` 已经说过一遍；这里不再把同一个问题说两次，也不下结论
    }
  }
  return stats;
}

function sampleText(stat: UnattributableStat): string {
  const more = stat.count > stat.samples.length ? ` 等 ${stat.count} 个` : '';
  // 样本是会话文件路径，同样直接进终端（文件名里的 ESC / 换行会改掉终端状态）
  return `${stat.samples.map((x) => escapeControlChars(x)).join('、')}${more}`;
}

/**
 * 列表与诊断共用的披露文案。
 *
 * 传了 `cwd` 才补「也无法判断它们是否属于这个目录」：列表是按目录答的，不补这句会被读成
 * 「这些文件不属于这里」；`watch doctor` 是全局视角，说这句反而多余。
 */
export function unattributableWarning(stat: UnattributableStat, cwd?: string): string {
  const { cause, advice } = causeAdvice(stat);
  const where = cwd ? `，也无法判断它们是否属于 ${escapeControlChars(cwd)}` : '';
  const locations = locationsText(stat);
  if (stat.count <= 0) {
    // 只有读不出来的位置（如 Kimi 的工作区分组）：不能说成「N 个会话文件」，
    // 一个分组里可能还有若干会话，数量根本未知。
    return (
      `${stat.displayName} ${locations ?? '有位置读不出来'}（${cause}），` +
      `里面可能还有会话，因此不会出现在任何目录的会话列表里${where}；这不代表它们不存在——${advice}`
    );
  }
  return (
    `${stat.displayName} 有 ${stat.count} 个会话文件读不出目录归属（${cause}），` +
    `因此不会出现在任何目录的会话列表里：${sampleText(stat)}${locations ? `；${locations}` : ''}；` +
    `这不代表它们不存在${where}——${advice}`
  );
}

/**
 * 列表为空时的结论句；`null` = 没有这一档，调用方沿用自己的原句。
 *
 * 「未发现会话」是一句结论，而这一档恰恰说明「没列出来不等于没有」——健康目录仍走原句。
 */
export function unattributableEmptyNote(stats: readonly UnattributableStat[]): string | null {
  if (!stats.length) return null;
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  const locationTotal = stats.reduce((sum, s) => sum + locationCount(s), 0);
  const names = stats.map((s) => s.displayName).join(' / ');
  const advice = [...new Set(stats.map((s) => causeAdvice(s).advice))].join('；');
  const what = [
    ...(total ? [`${total} 个会话文件读不出目录归属`] : []),
    ...(locationTotal ? [`${locationTotal} 个位置读不出来（里面可能还有会话）`] : []),
  ].join('、');
  return (
    `未发现可列出的原生会话；但 ${names} 另有 ${what}（原因见上方警告），` +
    `无法确认这个目录里是否还有它们的会话——${advice}，再重试`
  );
}

/** `--json` 用的结构化形状：脚本不必解析中文文案 */
export function unattributableJson(
  stats: readonly UnattributableStat[],
): { provider: string; count: number; locations?: number }[] {
  return stats.map((s) => {
    const locations = locationCount(s);
    return { provider: s.provider, count: s.count, ...(locations ? { locations } : {}) };
  });
}

/**
 * 这一档的公共描述（家数 / 条数 / 归属写在哪 / 样本路径）。
 *
 * `unattributableWarning()` 是说给「列表里少了东西」的读者；`unattributablePickWarning()` 与
 * `unattributableNoPickMessage()` 是说给**写路径**的——那两处大多是 `throw` 出去的（错误文案
 * 就是用户能看到的全部），所以不能写「原因见上方警告」：警告根本没送到。原因内联在这里。
 */
function hiddenByAttribution(
  stats: readonly UnattributableStat[],
): { names: string; parts: string[]; advice: string } | null {
  if (!stats.length) return null;
  const names = stats.map((s) => s.displayName).join(' / ');
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  const locationTotal = stats.reduce((sum, s) => sum + locationCount(s), 0);
  if (total === 0 && locationTotal === 0) return null;
  const causes = [...new Set(stats.map((s) => causeAdvice(s).cause))];
  const advice = [...new Set(stats.map((s) => causeAdvice(s).advice))].join('；');
  const parts: string[] = [];
  if (total > 0) {
    const samples = stats
      .filter((s) => s.samples.length > 0)
      .map((s) => (stats.length > 1 ? `${s.displayName}：${escapeControlChars(s.samples[0])}` : escapeControlChars(s.samples[0])))
      .slice(0, 3)
      .join('、');
    parts.push(
      `另有 ${total} 个会话文件读不出目录归属（${causes.join(' / ')}），` +
        `它们不属于任何目录、不会出现在会话列表里${samples ? `：${samples}` : ''}`,
    );
  }
  if (locationTotal > 0) {
    const samples = stats
      .flatMap((s) => (s.locations ?? []).flatMap((l) => l.samples))
      .slice(0, 3)
      .map((x) => escapeControlChars(x))
      .join('、');
    parts.push(`另有 ${locationTotal} 个位置读不出来（里面可能还有若干会话）${samples ? `：${samples}` : ''}`);
  }
  return { names, parts, advice };
}

/**
 * 「自动挑会话」时的披露：这一档的文件不属于任何目录，`listSessions` / `findLatestSession`
 * 只能跳过它们，于是「按修改时间最新」其实是「在能读出的那些里最新」。
 *
 * 第 286–288 轮把这条事实接到了五个**只读**入口（`sessions` / `recent` / `status` / `doctor` /
 * `search`），**写路径一处都没接**：`adopt` 不带 `--session` 时会宣称「按修改时间挑的最新会话」，
 * 而真正更新的那一条可能正躺在被跳过的文件里；`switch` 在链上没有来源绑定时同样按 mtime 自动挑来源；
 * `open --to` 的复用扫描只看得到健康会话，于是可能多建一份重复会话（与「撞列表上限」同一类后果，
 * 那一档第 302 轮已披露）。这几处都在**替用户做选择**，选的却是「能读出来的那部分里最新的」。
 *
 * `subject` 说明这次挑的是什么（「本次自动挑的会话」/「这次交接的来源」/「目标会话的复用匹配」），
 * `consequence` 说明后果——三处的后果不同，不能共用一句。
 */
export function unattributablePickWarning(
  stats: readonly UnattributableStat[],
  subject: string,
  consequence: string,
): string | null {
  const hidden = hiddenByAttribution(stats);
  if (!hidden) return null;
  return (
    `${hidden.names} ${hidden.parts.join('；')}；` +
    `本次${subject}只在能读出的会话里挑，没有把它们算进去——${consequence}；` +
    `${hidden.advice}`
  );
}

/**
 * 一个都没挑到时的结论句：`null` = 没有这一档，调用方沿用自己的原句（「未发现原生会话」）。
 *
 * 与 `unattributableEmptyNote()` 的区别：那条给 `sessions` / `recent` 这类**列表**用，读者能看到
 * 头顶那条警告；这里给 `handoff()` 的 `throw` 用，警告到不了调用方，所以原因与下一步都要写全，
 * 并且要明确指出「不能据此说这里没有会话」——否则用户会照着「先开一次会话」白开一个。
 */
export function unattributableNoPickMessage(stats: readonly UnattributableStat[]): string | null {
  const hidden = hiddenByAttribution(stats);
  if (!hidden) return null;
  return (
    `未发现可列出的原生会话；但 ${hidden.names} ${hidden.parts.join('；')}——` +
    `无法确认这个目录里是否还有可交接的会话（不能据此说「这里没有会话」）；` +
    `${hidden.advice}`
  );
}

/**
 * 「文件还在、内容却是 0 字节」的会话（判据与 `read-text.ts` 的 `describeEmptySessionFile()` 同源）。
 *
 * 这是与上面几档都不同的一件事：`previewError` 里也有权限 / 路径读不出来，但那要修权限；
 * 0 字节是**内容已经没了**（进程被杀 / 只写了一半 / 磁盘满），只能重新开一次会话或从备份恢复。
 * 两者混在一句话里会把人引去对着一个空文件反复查权限（第 289 轮在 `sessions` / `doctor`
 * 上拆过档，这里是同一件事在 `search` 侧的形状）。
 */
export type EmptiedSession = { provider: string; sessionId: string; filePath: string };

/**
 * 搜索是最后一个沉默的入口：索引里这些会话一行内容都没有，命中永远为零。
 *
 * 正文只回一句「本目录没有匹配」时，用户会以为那句话没聊过——而它可能正躺在一条内容已经
 * 丢失的会话里。`sessions` / `recent` / `doctor` 早已披露，这条补齐同一个事实。
 */
export function emptiedSessionsWarning(rows: readonly EmptiedSession[]): string {
  const samples = rows
    .slice(0, 3)
    .map((r) => `${r.provider}:${r.sessionId}`)
    .join('、');
  const more = rows.length > 3 ? ` 等 ${rows.length} 条` : '';
  return (
    `本目录有 ${rows.length} 条会话的文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${samples}${more}；` +
    '它们没有任何可搜索的内容——如果那句话本来在它们里面，只能从备份恢复（Watch 不会替你重建历史）'
  );
}

/**
 * 零命中时补的说明：讲的是**这次搜索的覆盖范围**，与上面那条讲事实与后果的警告分开。
 * 有命中时不说这句（命中了就说明这句话不在那些空文件里）。
 */
export function emptiedSearchNote(rows: readonly EmptiedSession[]): string | null {
  if (!rows.length) return null;
  return (
    `本次没有命中，其中 ${rows.length} 条会话的文件是空的（0 字节，内容已丢失，原因见上方警告）——` +
    '它们没有任何可搜索的内容，搜索即使覆盖到也搜不到；如果那句话本来在它们里面，只能从备份恢复'
  );
}

/** `--json` 用的结构化形状：脚本不必解析中文文案 */
export function emptiedJson(rows: readonly EmptiedSession[]): { provider: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
  return [...counts].map(([provider, count]) => ({ provider, count }));
}

/**
 * `watch search` 零命中时补的说明。
 * 搜索只遍历各家的 `listSessions(cwd)`，而这一档的文件**不属于任何 cwd**，永远进不了任何索引——
 * 于是「无结果」可能只是「这几条根本没被搜到」，而不是「没聊过」。
 * 与 `unattributableWarning()` 分开：那条讲事实与后果，这条讲**这次搜索的覆盖范围**。
 */
export function unattributableSearchNote(stats: readonly UnattributableStat[]): string | null {
  if (!stats.length) return null;
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  const locationTotal = stats.reduce((sum, s) => sum + locationCount(s), 0);
  const names = stats.map((s) => s.displayName).join(' / ');
  const advice = [...new Set(stats.map((s) => causeAdvice(s).advice))].join('；');
  const what = [
    ...(total ? [`${total} 个会话文件读不出目录归属`] : []),
    ...(locationTotal ? [`${locationTotal} 个位置读不出来（里面可能还有会话）`] : []),
  ].join('、');
  return (
    `本次没有命中；但 ${names} 另有 ${what}（原因见上方警告），` +
    '这些内容不属于任何目录，也就不会进任何目录的搜索索引——无法确认里面是否有你要找的内容，搜索没有覆盖到它们；' +
    `${advice}，再重试`
  );
}
