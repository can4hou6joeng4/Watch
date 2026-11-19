/**
 * 把不可信字符串安全地放进**终端**输出的唯一入口。
 *
 * 链名是用户输入，历史库里可能已经存着控制字符：2026-11-08 实测（修复前）把
 * `a\u001b[31mRED\u001b[0m\nb` 直接写进 `chains.name` 后，`watch chain list` 的终端输出是
 *
 * ```
 *   a^[[31mRED^[[0m
 * b ← 当前  …  lastUsed=…
 * ```
 *
 * 也就是 ESC 序列**真的进了终端**（能改颜色、改标题、清屏——终端转义注入），换行把表格
 * 折成两行。写入守卫（`assertChainNameUsable()`）只拦得住新名字，改不了已经落盘的旧数据，
 * 所以显示层必须有自己的一道。
 *
 * 生态里的同类做法是 `strip-ansi` 这一族库（chalk/strip-ansi 等）；这里选择**转义**而不是
 * 删除：删掉后 `aREDb` 与另一个真叫 `aREDb` 的链分不出来，转义后的 `\u001B` 能让人看出
 * 原文里就有控制字符，也照着原样抄不回去（抄回去仍会被写入口拒绝，方向一致）。
 *
 * 只处理控制字符（C0 U+0000–U+001F、DEL U+007F、C1 U+0080–U+009F）：中文、空格、标点照常显示。
 */
export function escapeControlChars(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += describeControlCharEscape(code);
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * 按**码点**截断到 `limit` 个字符，不附加省略号；被截断时 `truncated` 为 true。
 *
 * `String.prototype.slice()` 按 UTF-16 码元切，emoji 这类代理对会被切成孤立的一半，
 * 终端与 JSON 里显示为替换符。展示侧的截断统一走这里：先按原文码点切，需要省略号的
 * 由调用方补，需要转义控制字符的仍在截断**之后**做（先转义后截断会切出 `\u001` 半截序列，
 * 见 `unknownTypeLabel()` 与 v0.1.187–v0.1.189）。
 * 实现按 `limit` 提前停止遍历，超长正文（如 FTS 索引）不会先展开整串。
 */
export function clipCodePoints(text: string, limit: number): { text: string; truncated: boolean } {
  // 快路径：码元数不超过 limit 时码点数一定也不超过（代理对按两个码元算）
  if (text.length <= limit) return { text, truncated: false };
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === limit) break;
    count += 1;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}

/**
 * 总宽 `width` 码点（省略号计入）的单行截断：恰 `width` 码点原样保留，
 * 更长的取前 `width - 1` 码点加 `…`。用于「整句最多 N 字」的摘要与回显比对。
 */
export function clipCodePointsToWidth(text: string, width: number): string {
  const clipped = clipCodePoints(text, width);
  return clipped.truncated ? `${clipCodePoints(clipped.text, width - 1).text}…` : text;
}

/** 名字里是否有控制字符（决定要不要提示「显示时已转义、怎么修」）。 */
export function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

function describeControlCharEscape(code: number): string {
  switch (code) {
    case 0x00:
      return '\\u0000';
    case 0x09:
      return '\\t';
    case 0x0a:
      return '\\n';
    case 0x0d:
      return '\\r';
    case 0x1b:
      return '\\u001B';
    default: {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `\\u${hex}`;
    }
  }
}
