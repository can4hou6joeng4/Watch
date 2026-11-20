import { cwdControlCharsNote, splitElsewhereByDirectory } from './cwd.js';
import { escapeControlChars } from './display.js';
import { describeStoreErrorReason, type ChainsElsewhere, type Store } from './store.js';

/**
 * 「同一个目录的另一种写法下有链」的判定与文案。
 *
 * 链按 `--cwd` 的原字符串分组，而同一个物理目录可以有很多种写法（软链、`/var` 与
 * `/private/var` 这类前缀、名字大小写）。读路径（`chain list` / `status` / `usage` /
 * `doctor` / `search` / `switch` / `adopt` / `chain use`）一直会指出这件事；写路径
 * （`chain new` / `new`）也必须说，否则同一个项目里会出现两组互相看不见的链。
 *
 * 读写两侧对查询失败的容忍度不同，所以这里保留两个入口：
 * - `chainsElsewhereOf()` 只读口径：查询只是补充说明，读不出来就当没有；
 * - `aliasChainGroupWarning()` 写入口径：已经写进了链记录，查不出来必须说「无法确认」。
 */

/** 本目录一条链都没有时，本地库里其它目录的链（读路径用：查询失败当没有）。 */
export function chainsElsewhereOf(store: Store | null, cwd: string): ChainsElsewhere[] {
  if (!store) return [];
  try {
    return store.chainsElsewhere(cwd);
  } catch {
    return [];
  }
}

/**
 * 「别处的链」按真实路径分成「同一个目录的另一种写法」与「确实是别的目录」。
 *
 * 链按 `--cwd` 精确匹配，同一目录换个写法在库里就是两个 cwd，于是 `chainsElsewhere()`
 * 会把它们一起返回；只说「属于其它目录」是错的，`--json` 里也要能分辨，因此给那一档
 * 行加上 `sameDirectory: true`（其余行保持原样，不新增字段）。
 */
export async function splitChainsElsewhere(
  rows: ChainsElsewhere[],
  cwd: string,
): Promise<{ same: ChainsElsewhere[]; other: ChainsElsewhere[] }> {
  const split = await splitElsewhereByDirectory(rows, cwd);
  return {
    same: split.sameDirectory.map((r) => ({ ...r, sameDirectory: true })),
    other: split.otherDirectories,
  };
}

/** 读这个 cwd 下的链名；读不出来返回 null（补充说明不该让写命令失败）。 */
export function chainNamesOf(store: Store | null, cwd: string): string[] | null {
  if (!store) return null;
  try {
    return store.listChains(cwd).map((chain) => chain.name);
  } catch {
    return null;
  }
}

/**
 * 逐条比出这次新建的链名。读不出来（任一侧为 null）或一次新增了多条时返回 null——
 * 名字只是用来把说明指向那条链，判不出来就退回不带名字的说法，不猜。
 */
export function newChainName(before: string[] | null, after: string[] | null): string | null {
  if (!before || !after) return null;
  const added = after.filter((name) => !before.includes(name));
  return added.length === 1 ? added[0] : null;
}

/**
 * 写入侧（`chain new` / `new`）在「同一个目录的另一种写法」下已经有链时，必须说明这件事。
 *
 * 2026-11-09 实测（隔离 HOME，`<tmp>/proj-real` 软链成 `<tmp>/proj-link`）先
 * `chain new 主力 --cwd <real>`、再 `chain new 主力 --cwd <link>`，两次都是 `ok:true` 且
 * `warnings` 一个字都没有——同一个项目里于是有了两条都叫「主力」的链，`chain list`
 * 在两边各自标「← 当前」。`watch new claude --cwd <link>` 同样静默建出第二组「默认」链。
 *
 * 下一步只给「换成记录里的原字符串重跑」这一个真实可用的动作：绝不建议
 * `watch chain archive <刚建的名字>`——`archiveChain()` 拒绝归档本目录唯一的活跃链，而刚建出来的
 * 这条往往正是那唯一一条，等于给了一条注定失败的命令。
 */
export async function aliasChainGroupWarning(
  store: Store | null,
  cwd: string,
  createdName: string | null,
): Promise<string | null> {
  if (!store) return null;
  let rows: ChainsElsewhere[];
  try {
    rows = store.chainsElsewhere(cwd);
  } catch (error) {
    // 写路径不能沿用只读口径的静默：这条查询失败时「另一种写法下有没有链」无从得知，
    // 而这正是这次写入最需要核对的事。链记录已经写进去了，只能把「没查成」讲清楚。
    return (
      `无法确认 ${escapeControlChars(cwd)} 的其它写法下是否已有链（本地库查询失败：${describeStoreErrorReason(error)}）：` +
      '这次写的链记录只在当前 --cwd 的写法下可见——同一个目录换成另一种写法（软链、/private 与 /var 前缀、名字大小写）' +
      '在本地库里是另一个目录，两组链互相看不到。先按上面的原因处理本地库，' +
      '再用其它写法逐个执行只读的 watch chain list --cwd <写法> 核对（不会新建链，也不需要重跑写入命令）' +
      cwdControlCharsNote(cwd)
    );
  }
  const { same } = await splitChainsElsewhere(rows, cwd);
  if (!same.length) return null;
  const groups: string[] = [];
  const collisions: string[] = [];
  let total = 0;
  const shownCwd = escapeControlChars(cwd);
  for (const row of same) {
    total += row.total;
    const names = chainNamesOf(store, row.cwd) ?? [];
    if (createdName && names.includes(createdName)) collisions.push(row.cwd);
    const shown = names.slice(0, 3).map((name) => `「${escapeControlChars(name)}」`).join(' / ');
    const rowCwd = escapeControlChars(row.cwd);
    groups.push(
      shown ? `${rowCwd} 下有 ${shown}${names.length > 3 ? ` 等 ${names.length} 条` : ''}` : `${rowCwd} 下有 ${row.total} 条链（名字读不出来）`,
    );
  }
  const created = createdName
    ? `在 ${shownCwd} 下建了链「${escapeControlChars(createdName)}」`
    : `在 ${shownCwd} 下写了链记录`;
  const collision = collisions.length
    ? `；两个写法下都有「${escapeControlChars(createdName!)}」，但它们不是同一条链`
    : '';
  const moreGroup = same.length > 3 ? ` 等 ${same.length} 个写法` : '';
  const target = escapeControlChars(same[0].cwd);
  return (
    `${shownCwd} 和 ${same.slice(0, 3).map((r) => escapeControlChars(r.cwd)).join('、')}${moreGroup} 是同一个目录的另一种写法` +
    '（链按 --cwd 的原字符串分组，两种写法在本地库里是两个目录、互相看不到）。' +
    `这次${created}，而那个写法下已经有 ${total} 条链（${groups.join('；')}）${collision}。` +
    `同一个项目里现在有两组链：之后不带 --cwd 的 status / switch / new / adopt 只作用在当前这条 --cwd 对应的那一组上。` +
    `要接着用原来那一组，把 --cwd 换成 ${target} 重跑同一条命令（其余参数照旧）` +
    '——链记录的工作目录在创建时定死，没有改名 / 移动的办法' +
    cwdControlCharsNote(cwd)
  );
}
