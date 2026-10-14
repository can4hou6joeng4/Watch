const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message) => {
  throw new Error(`[site-pages] ${message}`);
};

const checkedDate = (value, label) => {
  if (!isoDatePattern.test(value)) fail(`${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
};

const checkedSiteOrigin = (siteUrl) => {
  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    fail(`siteUrl is invalid: ${siteUrl}`);
  }
  if (url.protocol !== 'https:') fail('siteUrl must use HTTPS');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('siteUrl must be an HTTPS origin without credentials, a path, query, or fragment');
  }
  return url.origin;
};

const checkedPath = (value, label) => {
  if (typeof value !== 'string' || !value.startsWith('/') || !value.endsWith('/')) {
    fail(`${label} must start and end with /`);
  }
  if (value.includes('//') || value.includes('?') || value.includes('#')) {
    fail(`${label} contains an invalid separator, query, or fragment`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail(`${label} contains invalid percent encoding`);
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail(`${label} contains path traversal`);
  }
  return value;
};

const xml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}[character]));

export function buildHomePageManifest({ siteUrl, locales, published, modified }) {
  const origin = checkedSiteOrigin(siteUrl);
  return Object.entries(locales).map(([locale, metadata]) => ({
    id: `home-${locale}`,
    locale,
    path: metadata.path,
    canonical: `${origin}${metadata.path}`,
    published,
    modified,
    alternateGroup: 'home',
  }));
}

export function buildGuidePageManifest({ siteUrl, locales, guides = [] }) {
  const origin = checkedSiteOrigin(siteUrl);
  const pages = [];
  for (const guide of guides) {
    if (guide.status !== 'published') continue;
    const alternateGroup = `guide-${guide.id}`;
    for (const locale of Object.keys(locales)) {
      const locData = guide.locales[locale] ?? guide.locales.en;
      if (!locData || !locData.slug) fail(`guide ${guide.id} missing locale ${locale}`);
      const guidePath = locales[locale].path === '/' ? `/guides/${locData.slug}/` : `${locales[locale].path}guides/${locData.slug}/`;
      pages.push({
        id: `guide-${guide.id}-${locale}`,
        locale,
        path: guidePath,
        canonical: `${origin}${guidePath}`,
        published: guide.published,
        modified: guide.modified,
        alternateGroup,
        guideId: guide.id,
      });
    }
  }
  return pages;
}

export function buildAllPageManifest({ siteUrl, locales, published, modified, guides = [] }) {
  const homePages = buildHomePageManifest({ siteUrl, locales, published, modified });
  const guidePages = buildGuidePageManifest({ siteUrl, locales, guides });
  return [...homePages, ...guidePages];
}

export function validatePageManifest({ pages, siteUrl, locales, defaultLocale, buildDate }) {
  if (!Array.isArray(pages) || pages.length === 0) fail('page manifest must not be empty');
  if (!locales || typeof locales !== 'object' || Object.keys(locales).length === 0) fail('locales must not be empty');
  if (!Object.hasOwn(locales, defaultLocale)) fail(`default locale is not configured: ${defaultLocale}`);

  const origin = checkedSiteOrigin(siteUrl);
  const checkedBuildDate = checkedDate(buildDate, 'buildDate');
  const ids = new Set();
  const canonicals = new Set();
  const paths = new Set();
  const groups = new Map();

  for (const page of pages) {
    if (!page || typeof page !== 'object') fail('every page must be an object');
    if (!idPattern.test(page.id)) fail(`page id must be lowercase kebab-case: ${page.id}`);
    if (ids.has(page.id)) fail(`duplicate page id: ${page.id}`);
    ids.add(page.id);

    if (!Object.hasOwn(locales, page.locale)) fail(`unknown locale for ${page.id}: ${page.locale}`);
    if (!idPattern.test(page.alternateGroup)) fail(`alternateGroup must be lowercase kebab-case: ${page.alternateGroup}`);
    checkedPath(page.path, `${page.id}.path`);

    let canonical;
    try {
      canonical = new URL(page.canonical);
    } catch {
      fail(`invalid canonical for ${page.id}: ${page.canonical}`);
    }
    if (canonical.protocol !== 'https:' || canonical.origin !== origin) {
      fail(`canonical must be same-origin HTTPS for ${page.id}: ${page.canonical}`);
    }
    if (canonical.username || canonical.password || canonical.search || canonical.hash) {
      fail(`canonical must not contain credentials, a query, or fragment for ${page.id}`);
    }
    if (canonical.pathname !== page.path || canonical.href !== `${origin}${page.path}`) {
      fail(`canonical and path differ for ${page.id}`);
    }
    if (canonicals.has(canonical.href)) fail(`duplicate canonical: ${canonical.href}`);
    if (paths.has(page.path)) fail(`duplicate public path: ${page.path}`);
    canonicals.add(canonical.href);
    paths.add(page.path);

    const published = checkedDate(page.published, `${page.id}.published`);
    const modified = checkedDate(page.modified, `${page.id}.modified`);
    if (modified < published) fail(`modified date precedes published date for ${page.id}`);
    if (published > checkedBuildDate || modified > checkedBuildDate) {
      fail(`page date is later than buildDate for ${page.id}`);
    }

    const group = groups.get(page.alternateGroup) ?? new Map();
    if (group.has(page.locale)) fail(`duplicate locale ${page.locale} in alternate group ${page.alternateGroup}`);
    group.set(page.locale, page);
    groups.set(page.alternateGroup, group);
  }

  for (const [groupName, group] of groups) {
    for (const locale of Object.keys(locales)) {
      if (!group.has(locale)) fail(`alternate group ${groupName} is missing locale ${locale}`);
    }
    if (group.size !== Object.keys(locales).length) fail(`alternate group ${groupName} contains unexpected locales`);
    if (!group.has(defaultLocale)) fail(`alternate group ${groupName} has no x-default target`);
  }

  return pages;
}

export function alternatePagesFor(page, pages, locales) {
  const group = pages.filter((candidate) => candidate.alternateGroup === page.alternateGroup);
  const byLocale = new Map(group.map((candidate) => [candidate.locale, candidate]));
  return Object.keys(locales).map((locale) => byLocale.get(locale));
}

export function renderSitemap({ pages, siteUrl, locales, defaultLocale, buildDate }) {
  validatePageManifest({ pages, siteUrl, locales, defaultLocale, buildDate });
  // Hreflang stays in HTML. The feed is loc/lastmod only, and Search Console is
  // given sitemap-pages.xml: sitemap.xml has been pending with no download since
  // 2026-09-13, while plain sitemaps on this property are fetched within seconds.
  const entries = pages.map((page) => (
    `  <url>\n    <loc>${xml(page.canonical)}</loc>\n    <lastmod>${page.modified}</lastmod>\n  </url>`
  ));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}
