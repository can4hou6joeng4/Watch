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
