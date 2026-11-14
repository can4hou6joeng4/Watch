/**
 * 把不可信文本安全地放进 Markdown 的少量工具。
 *
 * 这些文本来自工具参数与会话正文，`sanitizeBody()` 只处理控制字符并**刻意保留换行**，
 * 所以结构层的逃逸要在这一层挡住：内容里的反引号能截断行内代码，``` 能提前闭合围栏，
 * 换行能另起一行冒充清单条目或伪造小节。规则取自 CommonMark：定界符串必须比内容中
 * 最长的连续反引号串更长。
 */

/** 内容里最长的连续反引号串长度；Markdown 定界符必须比它更长。 */
export function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
}

/**
 * 行内代码的安全包裹。内容含反引号时在首尾补一个空格（渲染时会去掉），
 * 否则首尾的反引号会被并进定界符。
 */
export function inlineCode(text: string): string {
  const longest = longestBacktickRun(text);
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
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
