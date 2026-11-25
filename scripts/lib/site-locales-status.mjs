/**
 * 语言包的完整性判定（构建与 `scripts/check-site-locales.mjs` 共用，避免两套口径）。
 *
 * 页面外壳的固定文案由 `apply-site-locale.mjs` 的 chrome 表兜底，不要求在语言包里出现；
 * 除此之外，英文源里出现的每一句都必须有条目，否则 `translateContent()` 会在第一个缺键处抛错。
 * 判定结果同时给出孤儿键：语言包里存在、英文源里已经找不到的键——说明文案改过而译文没跟上。
 * 记号（CLI 参数 / 环境变量）另由 `localeTokenIssues()` 判定：缺键会被构建拦住，记号被翻译走不会。
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

/**
 * 用户指南里写「从 v0.1.x 起……」会把逐版本流水带进长期文档；版本一变，读者看到的仍是历史。
 * 只查手写指南的 zh / en 正文（不是首页的版本展示位，也不是 docs/evidence 的验收记录）。
 */
export function guideVersionHistoryIssues(guideList) {
  const issues = [];
  for (const guide of guideList) {
    for (const [locale, value] of Object.entries(guide.locales ?? {})) {
      const strings = new Set();
      collectStrings(value, strings);
      for (const text of strings) {
        const token = text.match(/\bv0\.1\.\d+\b/i)?.[0];
        if (token) issues.push({ guide: guide.id, locale, token, text: text.slice(0, 120) });
      }
    }
  }
  return issues;
}

/**
 * 英文源串里不该被翻译的记号：CLI 参数（`--flag`）与环境变量名（全大写加下划线）。
 * 译文必须让每个源记号原样出现，也不能出现源串里没有的同形记号——2026-11-23 的核对抓到
 * 德语把 `--json` 拼进 `--json-findings`、把 `--desktop-project` 拼进 `--desktop-project-Pfad`，
 * 读者照着抄会得到不存在的参数。只看「源串里本来就有记号」的条目，避免把正常改写报出来。
 */
const TOKEN_PATTERNS = [/(?<![\w-])--[a-z][a-z0-9-]*(?![\w-])/g, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g];

function tokensIn(text) {
  const tokens = new Set();
  for (const pattern of TOKEN_PATTERNS) for (const hit of text.matchAll(pattern)) tokens.add(hit[0]);
  return tokens;
}

/** 语言包的记号差异：missing = 源记号在译文里消失，invented = 译文出现源串没有的同形记号 */
export function localeTokenIssues(dictionary) {
  const issues = [];
  for (const [source, target] of Object.entries(dictionary)) {
    if (typeof target !== 'string') continue;
    const wanted = tokensIn(source);
    if (!wanted.size) continue;
    const found = tokensIn(target);
    for (const token of wanted) if (!found.has(token)) issues.push({ source, token, kind: 'missing' });
    for (const token of found) if (!wanted.has(token)) issues.push({ source, token, kind: 'invented' });
  }
  return issues;
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