import type { ProviderAdapter } from '../providers/adapter.js';

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
};

/** 逐家问一次；未实现的跳过，抛错的也跳过（那已由本家 `listSessions` 的失败通道说过） */
export async function collectUnattributable(
  adapters: readonly ProviderAdapter[],
): Promise<UnattributableStat[]> {
  const stats: UnattributableStat[] = [];
  for (const adapter of adapters) {
    if (!adapter.unattributable) continue;
    try {
      const result = await adapter.unattributable();
      if (result.count <= 0) continue;
      stats.push({
        provider: adapter.id,
        displayName: adapter.displayName,
        count: result.count,
        samples: result.samples,
        ...(result.summary ? { summary: result.summary } : {}),
      });
    } catch {
      // 整体读不出来时 `listSessions` 已经说过一遍；这里不再把同一个问题说两次，也不下结论
    }
  }
  return stats;
}

function sampleText(stat: UnattributableStat): string {
  const more = stat.count > stat.samples.length ? ` 等 ${stat.count} 个` : '';
  return `${stat.samples.join('、')}${more}`;
}

/**
 * 列表与诊断共用的披露文案。
 *
 * 传了 `cwd` 才补「也无法判断它们是否属于这个目录」：列表是按目录答的，不补这句会被读成
 * 「这些文件不属于这里」；`watch doctor` 是全局视角，说这句反而多余。
 */
export function unattributableWarning(stat: UnattributableStat, cwd?: string): string {
  const what = stat.summary ?? '会话归属的元数据';
  return (
    `${stat.displayName} 有 ${stat.count} 个会话文件读不出目录归属（${what}缺失或损坏），` +
    `因此不会出现在任何目录的会话列表里：${sampleText(stat)}；` +
    `这不代表它们不存在${cwd ? `，也无法判断它们是否属于 ${cwd}` : ''}——` +
    `先确认这些文件的内容（可能是被截断），能从备份恢复就别直接删`
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
  const names = stats.map((s) => s.displayName).join(' / ');
  return (
    `未发现可列出的原生会话；但 ${names} 另有 ${total} 个会话文件读不出目录归属（原因见上方警告），` +
    '无法确认这个目录里是否还有它们的会话——先确认这些文件的内容（可能是被截断，能从备份恢复就别直接删）再重试'
  );
}

/** `--json` 用的结构化形状：脚本不必解析中文文案 */
export function unattributableJson(stats: readonly UnattributableStat[]): { provider: string; count: number }[] {
  return stats.map((s) => ({ provider: s.provider, count: s.count }));
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
  const names = stats.map((s) => s.displayName).join(' / ');
  return (
    `本次没有命中；但 ${names} 另有 ${total} 个会话文件读不出目录归属（原因见上方警告），` +
    '它们不属于任何目录，也就不会进任何目录的搜索索引——无法确认里面是否有你要找的内容，搜索没有覆盖到它们；' +
    '先确认这些文件的内容（可能只是首行被截断、正文还在，能从备份恢复就别直接删）再重试'
  );
}
