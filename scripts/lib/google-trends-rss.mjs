import { XMLParser } from 'fast-xml-parser';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const allowedTrendHours = Object.freeze([4, 24, 48, 168]);
export const defaultTrendMarkets = Object.freeze([
  Object.freeze({ code: 'TW', name: 'Taiwan', audiences: Object.freeze(['zh-Hant']) }),
  Object.freeze({ code: 'HK', name: 'Hong Kong', audiences: Object.freeze(['zh-Hant']) }),
  Object.freeze({ code: 'SG', name: 'Singapore', audiences: Object.freeze(['zh', 'en']) }),
  Object.freeze({ code: 'US', name: 'United States', audiences: Object.freeze(['en']) }),
  Object.freeze({ code: 'GB', name: 'United Kingdom', audiences: Object.freeze(['en']) }),
  Object.freeze({ code: 'CA', name: 'Canada', audiences: Object.freeze(['en']) }),
  Object.freeze({ code: 'AU', name: 'Australia', audiences: Object.freeze(['en']) }),
  Object.freeze({ code: 'NZ', name: 'New Zealand', audiences: Object.freeze(['en']) }),
]);
export const trendCollectionPolicy = Object.freeze({
  defaultHours: 48,
  recommendedCadenceHours: 24,
  requestIntervalMs: 1_500,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  retryCount: 0,
  autoPublish: false,
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function isoNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('now() must return a valid Date');
  return value.toISOString();
}

export function selectTrendMarkets(value) {
  if (value === undefined || value === null || value === '') return [...defaultTrendMarkets];
  const codes = Array.isArray(value) ? value : String(value).split(',');
  const requested = codes.map((code) => String(code).trim().toUpperCase()).filter(Boolean);
  if (!requested.length) throw new TypeError('At least one trend market is required');
  if (new Set(requested).size !== requested.length) throw new TypeError('Trend market codes must be unique');
  const byCode = new Map(defaultTrendMarkets.map((market) => [market.code, market]));
  return requested.map((code) => {
    const market = byCode.get(code);
    if (!market) throw new TypeError(`Unsupported trend market: ${code}`);
    return market;
  });
}

export function buildGoogleTrendsRssUrl(market, hours = trendCollectionPolicy.defaultHours) {
  if (!allowedTrendHours.includes(hours)) throw new TypeError(`Unsupported trend window: ${hours} hours`);
  const code = requiredText(market?.code, 'market.code').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new TypeError(`Invalid trend market code: ${code}`);
  const url = new URL('https://trends.google.com/trending/rss');
  url.searchParams.set('geo', code);
  url.searchParams.set('hours', String(hours));
  return url.href;
}

export async function resolveExternalTrendOutput(value, repositoryRoot) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('--output must be an absolute path outside the repository');
  }
  const repo = await realpath(repositoryRoot);
  const parent = await realpath(path.dirname(value));
  if (!(await lstat(parent)).isDirectory()) throw new TypeError('--output parent must be a directory');
  const output = path.join(parent, path.basename(value));
  const relative = path.relative(repo, output);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new TypeError('--output must remain outside the repository');
  }
  try {
    await lstat(output);
    throw new TypeError(`--output already exists: ${output}`);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
  return output;
}

export function parseGoogleTrendsRss(xml, market, sourceUrl) {
  const text = requiredText(xml, 'RSS body');
  let parsed;
  try {
    parsed = xmlParser.parse(text);
  } catch (error) {
    throw new TypeError(`Invalid Google Trends RSS XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(parsed, 'RSS document');
  const rss = record(root.rss, 'RSS document.rss');
  const channel = record(rss.channel, 'RSS channel');
  const items = asArray(channel.item);
  if (!items.length) throw new TypeError(`Google Trends RSS returned no items for ${market.code}`);

  return items.map((value, itemIndex) => {
    const item = record(value, `RSS item[${itemIndex}]`);
    const relatedSearch = asArray(item['ht:news_item']).map((newsValue, newsIndex) => {
      const news = record(newsValue, `RSS item[${itemIndex}].news[${newsIndex}]`);
      return {
        title: optionalText(news['ht:news_item_title']),
        snippet: optionalText(news['ht:news_item_snippet']),
        url: safeHttpUrl(news['ht:news_item_url']),
        source: optionalText(news['ht:news_item_source']),
      };
    }).filter((news) => news.title || news.url);
    return {
      title: requiredText(item.title, `RSS item[${itemIndex}].title`),
      trafficCount: optionalText(item['ht:approx_traffic']),
      pubDate: optionalText(item.pubDate),
      picture: safeHttpUrl(item['ht:picture']),
      pictureSource: optionalText(item['ht:picture_source']),
      sourceUrl,
      relatedSearch,
    };
  });
}

async function fetchMarket(market, hours, fetchImpl, now) {
  const sourceUrl = buildGoogleTrendsRssUrl(market, hours);
  const response = await fetchImpl(sourceUrl, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      'user-agent': 'Watch/0.1.1 trend-research (+https://relay.bobochang.cn/)',
    },
    signal: AbortSignal.timeout(trendCollectionPolicy.requestTimeoutMs),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    throw new Error(`Google Trends RSS ${market.code} failed with HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}; no retry was attempted`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/xml/i.test(contentType)) throw new Error(`Google Trends RSS ${market.code} returned non-XML content type: ${contentType || 'missing'}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > trendCollectionPolicy.maxResponseBytes) {
    throw new Error(`Google Trends RSS ${market.code} exceeded the 5 MiB response limit`);
  }
  const body = await readBoundedResponseText(response, market.code);
  return {
    countryName: market.name,
    audiences: [...market.audiences],
    sourceUrl,
    fetchedAt: isoNow(now),
    trends: parseGoogleTrendsRss(body, market, sourceUrl),
  };
}

async function readBoundedResponseText(response, marketCode) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > trendCollectionPolicy.maxResponseBytes) {
      throw new Error(`Google Trends RSS ${marketCode} exceeded the 5 MiB response limit`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Google Trends RSS ${marketCode} returned an invalid response stream`);
      }
      bytes += value.byteLength;
      if (bytes > trendCollectionPolicy.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Google Trends RSS ${marketCode} exceeded the 5 MiB response limit`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

export async function collectGoogleTrendsRss({
  markets = defaultTrendMarkets,
  hours = trendCollectionPolicy.defaultHours,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(markets) || !markets.length) throw new TypeError('markets must be a non-empty array');
  if (markets.length > defaultTrendMarkets.length) throw new TypeError(`At most ${defaultTrendMarkets.length} markets may be collected`);
  if (!allowedTrendHours.includes(hours)) throw new TypeError(`Unsupported trend window: ${hours} hours`);
  const codes = markets.map((market) => requiredText(market?.code, 'market.code').toUpperCase());
  if (new Set(codes).size !== codes.length) throw new TypeError('Trend market codes must be unique');
  const selectedMarkets = selectTrendMarkets(codes);

  const collectedAt = isoNow(now);
  const data = {};
  for (const [index, market] of selectedMarkets.entries()) {
    if (index > 0) await sleepImpl(trendCollectionPolicy.requestIntervalMs);
    data[market.code] = await fetchMarket(market, hours, fetchImpl, now);
  }
  return {
    schemaVersion: 1,
    lastUpdate: collectedAt,
    countries: selectedMarkets.length,
    source: {
      kind: 'google-trends-trending-now-rss',
      hours,
      requestedMarkets: codes,
      requestIntervalMs: trendCollectionPolicy.requestIntervalMs,
      retryCount: trendCollectionPolicy.retryCount,
      recommendedCadenceHours: trendCollectionPolicy.recommendedCadenceHours,
      mainlandChinaIncluded: false,
      mainlandChinaNote: 'CN is not queried; TW, HK and SG are independent discovery markets, not proxies for mainland China demand.',
      autoPublish: false,
    },
    data,
  };
}
