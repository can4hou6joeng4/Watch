/**
 * 顶层命令的三张表：每个命令消费哪些 flag、接受几个位置参数，以及由此派生的命令清单。
 *
 * 放在同一个模块里是为了让它们只有一个来源。以前命令清单是手写的一行字符串，
 * `capabilities` 与 `prompt` 加进分派和 flag 表之后没有补进去：`watch promt` 报
 * 「未知命令: promt；可用: status / … / open」——清单里恰好没有用户想打的那个命令。
 * 位置参数表同样漏了 `capabilities`，`watch capabilities foo` 照样 exit 0。
 * 现在清单由 `FLAGS_BY_COMMAND` 的键派生，两张表的覆盖面由回归逐项核对。
 */

/**
 * 每个命令真正消费的参数。`parseArgs` 只挡未知 flag（白名单是全局的），
 * `--chain` 给 `recent`、`--session` 给 `status` 这类「认识但不吃」的组合以前被静默忽略，
 * 用户会以为已经按链过滤 / 指定了会话。`--cwd` / `--json` 全局有效，不参与校验。
 */
export const FLAGS_BY_COMMAND: Record<string, string[]> = {
  status: ['chain'],
  switch: ['chain'],
  adopt: ['chain', 'session'],
  sessions: ['chain'],
  recent: ['limit'],
  providers: [],
  capabilities: [],
  prompt: ['provider', 'profile', 'last', 'since-compact'],
  doctor: ['strict'],
  new: ['chain'],
  chain: [],
  search: ['reset-index'],
  usage: ['chain'],
  open: ['from', 'provider', 'to', 'check'],
};

/**
 * 每个命令接受的位置参数（命令名之后）。`rejectUnusedFlags` 只管 `--flag`；
 * `watch recent 3`（本意是 `--limit 3`）、`watch status foo` 这类多给的位置参数
 * 以前被静默吞掉、照样 exit 0，用户会以为参数生效了。`search` 不限：查询词本身就是位置参数。
 */
export const POSITIONAL_BY_COMMAND: Record<string, { max: number; hint: string }> = {
  status: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  switch: { max: 1, hint: '<provider>' },
  adopt: { max: 1, hint: '<provider>（会话用 --session 传）' },
  sessions: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  recent: { max: 0, hint: '无位置参数（条数用 --limit 传）' },
  providers: { max: 0, hint: '无位置参数' },
  capabilities: { max: 0, hint: '无位置参数' },
  doctor: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  new: { max: 1, hint: '<provider>' },
  chain: { max: Infinity, hint: '<list|new|rename|archive|use> [名字或 id] [新名字]' },
  usage: { max: 0, hint: '无位置参数' },
  open: { max: 1, hint: '<session-id>' },
  prompt: { max: 1, hint: '[<session-id>]（省略时自动挑本目录最新的可读会话）' },
};

/** 位置参数刻意不设上限的命令：`search` 的查询词可以是多个词 */
export const UNBOUNDED_POSITIONAL_COMMANDS: readonly string[] = ['search'];

/** `chain` 各子命令吃的位置参数个数；未知子命令交给 cmdChain 自己报错，这里不拦 */
export const CHAIN_POSITIONAL: Record<string, number> = { list: 1, new: 2, rename: 3, archive: 2, use: 2 };

/** `import-codex` 在全局 parseArgs 之前就分派了，不在上面两张表里，清单里单独补上 */
export const EARLY_DISPATCH_COMMANDS: readonly string[] = ['import-codex'];

/** 顶层命令名（顺序即 flag 表的书写顺序，与用法文本的阅读顺序接近） */
export const COMMAND_NAMES: readonly string[] = [...Object.keys(FLAGS_BY_COMMAND), ...EARLY_DISPATCH_COMMANDS];

/** 给「未知命令 / 缺少子命令」用的可用命令清单 */
export const COMMAND_LIST = COMMAND_NAMES.join(' / ');

/**
 * 编辑距离（optimal string alignment）：增、删、改各算一次，相邻两个字符对调也算一次——
 * `stauts` 这类对调是最常见的手误。命令名都很短，直接用整张表，不做空间优化。
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) table[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(table[i - 1]![j]! + 1, table[i]![j - 1]! + 1, table[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, table[i - 2]![j - 2]! + 1);
      }
      table[i]![j] = best;
    }
  }
  return table[rows - 1]![cols - 1]!;
}

/**
 * 拼错的命令名最接近哪一个。只在**唯一**的近邻上给建议：两个候选一样近时宁可不猜——
 * 建议错了比不建议更糟，用户会照着一个不相干的命令去跑。
 * 阈值随长度放宽（短命令 1 次编辑，较长的 2 次），且不超过输入长度的一半。
 */
export function closestCommand(input: string, candidates: readonly string[] = COMMAND_NAMES): string | null {
  const typed = input.trim().toLowerCase();
  if (!typed || candidates.includes(typed)) return null;
  const limit = Math.min(typed.length <= 4 ? 1 : 2, Math.floor(typed.length / 2));
  if (limit < 1) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  if (bestDistance > limit || tied) return null;
  return best;
}
