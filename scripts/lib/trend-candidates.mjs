const coreKeywordGroups = [
  ['OpenAI', ['openai']],
  ['ChatGPT', ['chatgpt']],
  ['Anthropic', ['anthropic']],
  ['Claude Code', ['claude code']],
  ['Codex', ['openai codex', 'codex cli', 'codex']],
  ['OpenCode', ['opencode']],
  ['GitHub Copilot', ['github copilot']],
  ['Cursor AI', ['cursor ai', 'cursor editor']],
  ['Gemini CLI', ['gemini cli']],
  ['Windsurf', ['windsurf ai', 'windsurf editor']],
  ['Model Context Protocol', ['model context protocol', 'mcp server']],
  ['AI coding agent', ['ai coding agent', 'coding agent', 'agentic coding']],
  ['Session handoff intent', ['session handoff', 'conversation handoff', '会话接力', '会话迁移']],
  ['Claude limit intent', ['claude code limit', 'claude code quota', 'claude code 限额', 'claude code 上下文满了']],
  ['Cross-agent intent', ['claude code to codex', 'switch from claude code to codex', 'codex resume', 'codex session', 'opencode session']],
];

const adjacentKeywordGroups = [
  ['AI', ['ai', 'artificial intelligence', '人工智能']],
  ['AI agent', ['ai agent', 'agentic ai', '智能体']],
  ['Coding assistant', ['coding assistant', 'programming assistant', '代码助手']],
  ['AI IDE', ['ai ide', '智能编程工具']],
  ['Large language model', ['large language model', 'llm', '大模型']],
];

export const trendKeywordTiers = Object.freeze({
  core: Object.freeze(coreKeywordGroups.map(([label, phrases]) => Object.freeze({ label, phrases: Object.freeze(phrases) }))),
  adjacent: Object.freeze(adjacentKeywordGroups.map(([label, phrases]) => Object.freeze({ label, phrases: Object.freeze(phrases) }))),
});

function normalizeText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePhrase(phrase) {
  const normalized = normalizeText(phrase);
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(normalized)) {
    return (text) => text.includes(normalized);
  }
  const body = normalized.split(' ').map(escapePattern).join('[\\s\\-_/.:]+');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return (text) => pattern.test(text);
}

const matchers = Object.fromEntries(Object.entries(trendKeywordTiers).map(([tier, groups]) => [
  tier,
  groups.map((group) => ({ label: group.label, matches: group.phrases.map(compilePhrase) })),
]));

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string when present`);
  return value.trim() || null;
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

export function parseTrafficLowerBound(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().replaceAll(',', '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?\+?$/i);
  if (!match) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase()] ?? 1;
  return Number(match[1]) * multiplier;
}

export function classifyTrendTitle(title) {
  const normalized = normalizeText(nonEmptyString(title, 'trend title'));
  for (const tier of ['core', 'adjacent']) {
    const reasons = matchers[tier]
      .filter((group) => group.matches.some((matches) => matches(normalized)))
      .map((group) => group.label);
    if (reasons.length) return { tier, reasons };
  }
  return null;
}

function normalizeRelatedSearches(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array when present`);
  return value.map((item, index) => {
    const related = record(item, `${label}[${index}]`);
    return {
      title: optionalString(related.title, `${label}[${index}].title`),
      source: optionalString(related.source, `${label}[${index}].source`),
      url: safeHttpUrl(related.url),
    };
  });
}

function normalizeSnapshot(snapshot) {
  const root = record(snapshot, 'snapshot');
  const lastUpdate = nonEmptyString(root.lastUpdate, 'snapshot.lastUpdate');
  if (!Number.isInteger(root.countries) || root.countries < 1) {
    throw new TypeError('snapshot.countries must be a positive integer');
  }
  const data = record(root.data, 'snapshot.data');
  let source = { format: 'fdciabdul-google-trends-all', hours: null, requestedMarkets: null };
  if (root.source !== undefined && root.source !== null) {
    const sourceRecord = record(root.source, 'snapshot.source');
    source = {
      format: nonEmptyString(sourceRecord.kind, 'snapshot.source.kind'),
      hours: Number.isInteger(sourceRecord.hours) ? sourceRecord.hours : null,
      requestedMarkets: Array.isArray(sourceRecord.requestedMarkets)
        ? sourceRecord.requestedMarkets.map((value, index) => nonEmptyString(value, `snapshot.source.requestedMarkets[${index}]`))
        : null,
    };
  }
  const countryEntries = Object.entries(data);
  if (countryEntries.length !== root.countries) {
    throw new TypeError(`snapshot.countries reports ${root.countries}, but snapshot.data contains ${countryEntries.length}`);
  }

  const countries = countryEntries.map(([code, value]) => {
    const country = record(value, `snapshot.data.${code}`);
    const countryName = nonEmptyString(country.countryName, `snapshot.data.${code}.countryName`);
    if (!Array.isArray(country.trends)) throw new TypeError(`snapshot.data.${code}.trends must be an array`);
    const trends = country.trends.map((value, index) => {
      const label = `snapshot.data.${code}.trends[${index}]`;
      const trend = record(value, label);
      return {
        title: nonEmptyString(trend.title, `${label}.title`),
        trafficCount: optionalString(trend.trafficCount, `${label}.trafficCount`),
        pubDate: optionalString(trend.pubDate, `${label}.pubDate`),
        relatedSearches: normalizeRelatedSearches(trend.relatedSearch, `${label}.relatedSearch`),
      };
    });
    return { code, countryName, trends };
  });

  return { lastUpdate, reportedCountries: root.countries, source, countries };
}

function newestIsoDate(current, rawDate) {
  if (!rawDate) return current;
  const timestamp = Date.parse(rawDate);
  if (!Number.isFinite(timestamp)) return current;
  const value = new Date(timestamp).toISOString();
  return !current || value > current ? value : current;
}

function roundPercent(numerator, denominator) {
  return denominator ? Number((numerator * 100 / denominator).toFixed(6)) : 0;
}

export function analyzeTrendSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const groups = new Map();
  const allTitleKeys = new Set();
  const trendCounts = [];
  let totalEntries = 0;
  let candidateOccurrences = 0;
  let coreOccurrences = 0;
  let adjacentOccurrences = 0;

  for (const country of normalized.countries) {
    trendCounts.push(country.trends.length);
    for (const trend of country.trends) {
      totalEntries += 1;
      const titleKey = normalizeText(trend.title);
      allTitleKeys.add(titleKey);
      const classification = classifyTrendTitle(trend.title);
      if (!classification) continue;

      candidateOccurrences += 1;
      if (classification.tier === 'core') coreOccurrences += 1;
      else adjacentOccurrences += 1;

      let group = groups.get(titleKey);
      if (!group) {
        group = {
          dedupeKey: titleKey,
          title: trend.title,
          tier: classification.tier,
          reasons: new Set(),
          occurrences: 0,
          countries: new Map(),
          trafficCounts: new Set(),
          maxTrafficLowerBound: null,
          latestPublishedAt: null,
          relatedSources: new Map(),
        };
        groups.set(titleKey, group);
      }
      for (const reason of classification.reasons) group.reasons.add(reason);
      group.occurrences += 1;
      const countryRecord = group.countries.get(country.code) ?? { code: country.code, name: country.countryName, occurrences: 0 };
      countryRecord.occurrences += 1;
      group.countries.set(country.code, countryRecord);
      if (trend.trafficCount) group.trafficCounts.add(trend.trafficCount);
      const traffic = parseTrafficLowerBound(trend.trafficCount);
      if (traffic !== null && (group.maxTrafficLowerBound === null || traffic > group.maxTrafficLowerBound)) {
        group.maxTrafficLowerBound = traffic;
      }
      group.latestPublishedAt = newestIsoDate(group.latestPublishedAt, trend.pubDate);
      for (const related of trend.relatedSearches) {
        if (!related.url) continue;
        group.relatedSources.set(related.url, related);
      }
    }
  }

  const candidates = [...groups.values()].map((group) => {
    const allRelatedSources = [...group.relatedSources.values()].sort((left, right) => left.url.localeCompare(right.url));
    return {
      dedupeKey: group.dedupeKey,
      title: group.title,
      tier: group.tier,
      reasons: [...group.reasons].sort(),
      occurrences: group.occurrences,
      countries: [...group.countries.values()].sort((left, right) => left.code.localeCompare(right.code)),
      trafficCounts: [...group.trafficCounts].sort((left, right) => (parseTrafficLowerBound(right) ?? -1) - (parseTrafficLowerBound(left) ?? -1)),
      maxTrafficLowerBound: group.maxTrafficLowerBound,
      latestPublishedAt: group.latestPublishedAt,
      relatedSourceCount: allRelatedSources.length,
      relatedSources: allRelatedSources.slice(0, 25),
      publicationEligible: false,
      nextAction: 'editorial-review-required',
    };
  }).sort((left, right) => {
    const tier = { core: 0, adjacent: 1 };
    return tier[left.tier] - tier[right.tier]
      || (right.maxTrafficLowerBound ?? -1) - (left.maxTrafficLowerBound ?? -1)
      || right.occurrences - left.occurrences
      || left.title.localeCompare(right.title);
  });

  const coreUniqueTitles = candidates.filter((candidate) => candidate.tier === 'core').length;
  const adjacentUniqueTitles = candidates.filter((candidate) => candidate.tier === 'adjacent').length;
  return {
    schemaVersion: 1,
    source: {
      format: normalized.source.format,
      lastUpdate: normalized.lastUpdate,
      reportedCountries: normalized.reportedCountries,
      parsedCountries: normalized.countries.length,
      hours: normalized.source.hours,
      requestedMarkets: normalized.source.requestedMarkets,
    },
    summary: {
      totalEntries,
      uniqueTitles: allTitleKeys.size,
      minTrendsPerCountry: Math.min(...trendCounts),
      maxTrendsPerCountry: Math.max(...trendCounts),
      candidateOccurrences,
      candidateUniqueTitles: candidates.length,
      hitRatePercent: roundPercent(candidateOccurrences, totalEntries),
      core: {
        occurrences: coreOccurrences,
        uniqueTitles: coreUniqueTitles,
        hitRatePercent: roundPercent(coreOccurrences, totalEntries),
      },
      adjacent: {
        occurrences: adjacentOccurrences,
        uniqueTitles: adjacentUniqueTitles,
        hitRatePercent: roundPercent(adjacentOccurrences, totalEntries),
      },
    },
    policy: {
      autoPublish: false,
      decision: 'editorial-review-required',
      notes: [
        'A trend match is only a discovery signal, not a content recommendation.',
        'Related URLs are untrusted upstream data and require source verification.',
        'Cross-country traffic counts must not be summed as search volume.',
      ],
    },
    candidates,
  };
}

function tableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderTrendCandidateMarkdown(report) {
  const lines = [
    '# Watch Google Trends Candidate Report',
    '',
    `- Source update: ${report.source.lastUpdate}`,
    `- Countries: ${report.source.parsedCountries}`,
    `- Trend entries: ${report.summary.totalEntries}`,
    `- Unique titles: ${report.summary.uniqueTitles}`,
    `- Core matches: ${report.summary.core.occurrences} occurrences / ${report.summary.core.uniqueTitles} titles (${report.summary.core.hitRatePercent}%)`,
    `- Adjacent matches: ${report.summary.adjacent.occurrences} occurrences / ${report.summary.adjacent.uniqueTitles} titles (${report.summary.adjacent.hitRatePercent}%)`,
    '- Publication: disabled; every match requires editorial review.',
    '',
  ];
  if (!report.candidates.length) {
    lines.push('No core or adjacent Watch signals were found.', '');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| Tier | Title | Reasons | Countries | Occurrences | Max traffic floor |',
    '|---|---|---|---:|---:|---:|',
  );
  for (const candidate of report.candidates) {
    lines.push(`| ${tableCell(candidate.tier)} | ${tableCell(candidate.title)} | ${tableCell(candidate.reasons.join(', '))} | ${candidate.countries.length} | ${candidate.occurrences} | ${candidate.maxTrafficLowerBound ?? 'unknown'} |`);
  }
  lines.push('', 'All candidates remain `editorial-review-required`; this report cannot trigger publishing.', '');
  return `${lines.join('\n')}\n`;
}
