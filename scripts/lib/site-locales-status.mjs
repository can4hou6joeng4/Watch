/**
 * 语言包的完整性判定（构建与 `scripts/check-site-locales.mjs` 共用，避免两套口径）。
 *
 * 页面外壳的固定文案由 `apply-site-locale.mjs` 的 chrome 表兜底，不要求在语言包里出现；
 * 除此之外，英文源里出现的每一句都必须有条目，否则 `translateContent()` 会在第一个缺键处抛错。
 * 判定结果同时给出孤儿键：语言包里存在、英文源里已经找不到的键——说明文案改过而译文没跟上。
 */

/** 由 chrome 表兜底、不要求出现在语言包里的固定文案 */
export const CHROME_FALLBACK = new Set([
  'Language', 'Home', 'Frequently Asked Questions', 'Official Sources & Acceptance Records',
  'WATCH TECHNICAL GUIDE / SESSION HANDOFF', 'Published', 'Modified', 'Applies to',
  'Return to Watch Home', 'Download Watch Desktop',
]);

function collectStrings(value, out) {
  if (typeof value === 'string') {
    if (value) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * 英文源串全集：首页等内容取 `content.en`，指南取每个 `guide.locales.en`（与 build-site 一致）。
 * 同时返回每句所属的指南 id，方便报告里按指南分组。
 */
export function collectEnglishStrings(contentEn, guideList) {
  const strings = new Set();
  collectStrings(contentEn, strings);
  const owner = new Map();
  for (const guide of guideList) {
    const own = new Set();
    collectStrings(guide.locales.en, own);
    for (const text of own) owner.set(text, guide.id);
    for (const text of own) strings.add(text);
  }
  return { strings, owner };
}

/** 一个语言包相对英文源的缺口：缺哪些源串（按指南分组）、以及孤儿键 */
export function localeGaps(dictionary, english) {
  const missing = [...english.strings].filter((text) => !CHROME_FALLBACK.has(text) && !Object.hasOwn(dictionary, text));
  const orphans = Object.keys(dictionary).filter((key) => !english.strings.has(key));
  const byGuide = new Map();
  for (const text of missing) {
    const owner = english.owner.get(text) ?? '(首页等共享内容)';
    byGuide.set(owner, (byGuide.get(owner) ?? 0) + 1);
  }
  return { missing, orphans, byGuide };
}