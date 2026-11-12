/**
 * ECMAScript `Date` 能表示的最大时间值（±8.64e15 毫秒，约 ±275760 年）。
 *
 * 超出范围的数值 `new Date(x)` **不抛错**（得到 Invalid Date），但紧接着的
 * `.toISOString()` 抛 `RangeError: Invalid time value`——错误发生在格式化那一刻，
 * 调用方看到的像「整份文件读坏了」，而不是「这一条没有时间」。
 */
const MAX_DATE_MS = 8.64e15;

/**
 * 原生记录里的数值时间戳（毫秒）→ ISO 字符串；非有限、越界或无法表示时返回 `''`。
 *
 * 空串在本仓库是既有的「没有时间戳」表示（kimi 缺 `time`、pi 缺 `timestamp` 都落这个值），
 * 展示层会按缺失处理。**不要在这里兜底 `now()`**：同一条会话每次解析得到不同时间，
 * `watch prompt` 会声称对话发生在执行命令的那一刻（grok 在 2026-11-10 已因同一原因
 * 把 `now()` 换成文件 mtime）。
 *
 * 为什么解析器不能直接 `new Date(x).toISOString()`：parser 逐条读取原生记录，一条损坏
 * 记录（单位写错、字段被写坏、上游 bug）就让**整条会话**解析抛错——`open` / `switch` /
 * `usage` / `prompt` 全变成「读不出来」。时间戳是辅助字段，不该有这种权力。
 */
export function isoFromEpochMs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value < -MAX_DATE_MS || value > MAX_DATE_MS) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
