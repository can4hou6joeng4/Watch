/**
 * 把不可信文本安全地放进 Markdown 的少量工具。
 *
 * 这些文本来自工具参数与会话正文，`sanitizeBody()` 只处理控制字符并**刻意保留换行**，
 * 所以结构层的逃逸要在这一层挡住：内容里的反引号能截断行内代码，``` 能提前闭合围栏，
 * 换行能另起一行冒充清单条目或伪造小节。规则取自 CommonMark：定界符串必须比内容中
 * 最长的连续反引号串更长。
 */

/**
 * 内容里最长的连续反引号串长度；Markdown 定界符必须比它更长。
 *
 * 不要写成 `Math.max(0, ...matches)`：长命令可以有几十万个反引号串，
 * 展开参数会抛 `RangeError: Maximum call stack size exceeded`，整份 prompt 生成失败。
 */
export function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return longest;
}

/**
 * 行内代码的安全包裹。
 *
 * - 内容里的反引号：定界符必须比最长反引号串更长，否则会被内容截断。
 * - 空串没有合法的空代码跨度（` `` ` 只是两个裸反引号），用一个空格内容占位；
 *   调用方有更明确的占位文案时（如「（空命令）」）优先用文案。
 * - CommonMark 会剥掉「首尾都是空格、且并非全空格」内容的一层空格；这类内容要
 *   在两侧各补一个空格抵消，否则 `' a '` 被静默渲染成 `a`。
 */
export function inlineCode(text: string): string {
  if (text === '') return '` `';
  const longest = longestBacktickRun(text);
  const fence = '`'.repeat(longest + 1);
  const needsPad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  const pad = needsPad ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** 围栏代码块的定界符：至少三个反引号，且必须长于内容里最长的反引号串。 */
export function codeFence(text: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
}

/** 单行条目里的换行折成可见占位：否则内容能另起一行伪造清单条目或小节。 */
export function singleLineText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n');
}
