const decodeXmlText = (value) => value
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'");

const checkedOrigin = (siteUrl) => {
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash || site.username || site.password) {
    throw new Error('IndexNow site URL must be an HTTPS origin');
  }
  return site.origin;
};

const checkedUrl = (value, origin) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid IndexNow URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash) {
    throw new Error(`IndexNow URL must be same-origin HTTPS without credentials, query, or fragment: ${value}`);
  }
  return url.href;
};

export function sitemapLocations(xml) {
  if (typeof xml !== 'string' || !xml.includes('<urlset')) throw new Error('Sitemap XML is missing urlset');
  const locOpenCount = (xml.match(/<loc>/g) ?? []).length;
  const matches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)];
  if (matches.length === 0 || matches.length !== locOpenCount) throw new Error('Sitemap XML has missing or malformed loc elements');
  return matches.map((match) => decodeXmlText(match[1].trim()));
}

export function buildIndexNowUrlList({ sitemapXml, siteUrl, extraPaths = [] }) {
  const origin = checkedOrigin(siteUrl);
  const urls = sitemapLocations(sitemapXml).map((value) => checkedUrl(value, origin));
  for (const path of extraPaths) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('?') || path.includes('#')) {
      throw new Error(`Invalid IndexNow extra path: ${path}`);
    }
    urls.push(checkedUrl(`${origin}${path}`, origin));
  }
  return [...new Set(urls)];
}
