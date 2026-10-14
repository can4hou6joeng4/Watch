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

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export const trendObservationTimeZone = 'Asia/Shanghai';
const observationDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: trendObservationTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function calendarDate(value) {
  const parts = Object.fromEntries(observationDateFormatter.formatToParts(value)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function observationDate(value, label) {
  const text = nonEmptyString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid date-time`);
  return calendarDate(new Date(timestamp));
}

function normalizeMarkets(value, label) {
  if (!Array.isArray(value) || !value.length) throw new TypeError(`${label} must be a non-empty array`);
  const markets = value.map((market, index) => nonEmptyString(market, `${label}[${index}]`).toUpperCase());
  if (new Set(markets).size !== markets.length) throw new TypeError(`${label} must contain unique markets`);
  return markets;
}

function normalizeCandidate(value, label) {
  const candidate = record(value, label);
  const tier = nonEmptyString(candidate.tier, `${label}.tier`);
  if (tier !== 'core' && tier !== 'adjacent') throw new TypeError(`${label}.tier must be core or adjacent`);
  if (candidate.publicationEligible !== false) throw new TypeError(`${label}.publicationEligible must remain false`);
  if (!Array.isArray(candidate.reasons)) throw new TypeError(`${label}.reasons must be an array`);
  if (!Array.isArray(candidate.countries)) throw new TypeError(`${label}.countries must be an array`);
  return {
    dedupeKey: nonEmptyString(candidate.dedupeKey, `${label}.dedupeKey`),
    title: nonEmptyString(candidate.title, `${label}.title`),
    tier,
    reasons: candidate.reasons.map((reason, index) => nonEmptyString(reason, `${label}.reasons[${index}]`)),
    occurrences: positiveInteger(candidate.occurrences, `${label}.occurrences`),
    countries: candidate.countries.map((value, index) => {
      const country = record(value, `${label}.countries[${index}]`);
      return nonEmptyString(country.code, `${label}.countries[${index}].code`).toUpperCase();
    }),
    maxTrafficLowerBound: candidate.maxTrafficLowerBound === null
      ? null
      : nonNegativeNumber(candidate.maxTrafficLowerBound, `${label}.maxTrafficLowerBound`),
  };
}

function normalizeObservation(entry, index, today) {
  const item = record(entry, `entries[${index}]`);
  const report = record(item.report, `entries[${index}].report`);
  if (report.schemaVersion !== 2) throw new TypeError(`entries[${index}].report must use schemaVersion 2`);
  const policy = record(report.policy, `entries[${index}].report.policy`);
  if (policy.autoPublish !== false || policy.mixedRanking !== false) {
    throw new TypeError(`entries[${index}].report must disable auto-publishing and mixed ranking`);
  }
  const signals = record(report.signals, `entries[${index}].report.signals`);
  const trending = record(signals.trendingNow, `entries[${index}].report.signals.trendingNow`);
  if (trending.schemaVersion !== 1) throw new TypeError(`entries[${index}].trendingNow must use schemaVersion 1`);
  const source = record(trending.source, `entries[${index}].trendingNow.source`);
  const summary = record(trending.summary, `entries[${index}].trendingNow.summary`);
  const trendingPolicy = record(trending.policy, `entries[${index}].trendingNow.policy`);
  if (trendingPolicy.autoPublish !== false) throw new TypeError(`entries[${index}].trendingNow must disable auto-publishing`);
  if (!Array.isArray(trending.candidates)) throw new TypeError(`entries[${index}].trendingNow.candidates must be an array`);

  const date = observationDate(source.lastUpdate, `entries[${index}].trendingNow.source.lastUpdate`);
  if (date > today) throw new TypeError(`entries[${index}] observation date ${date} is in the future`);
  const candidates = trending.candidates.map((candidate, candidateIndex) => (
    normalizeCandidate(candidate, `entries[${index}].trendingNow.candidates[${candidateIndex}]`)
  ));
  const reportedCount = nonNegativeInteger(summary.candidateUniqueTitles, `entries[${index}].summary.candidateUniqueTitles`);
  if (reportedCount !== candidates.length) {
    throw new TypeError(`entries[${index}] reports ${reportedCount} candidates but contains ${candidates.length}`);
  }
  return {
    inputName: item.inputName === null || item.inputName === undefined
      ? null
      : nonEmptyString(item.inputName, `entries[${index}].inputName`),
    date,
    sourceUpdatedAt: nonEmptyString(source.lastUpdate, `entries[${index}].trendingNow.source.lastUpdate`),
    hours: nonNegativeInteger(source.hours, `entries[${index}].trendingNow.source.hours`),
    requestedMarkets: normalizeMarkets(source.requestedMarkets, `entries[${index}].trendingNow.source.requestedMarkets`),
    candidates,
  };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayDifference(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86_400_000);
}

export function summarizeTrendResearchReports(entries, {
  requiredConsecutiveDays = 14,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new TypeError('entries must be a non-empty array');
  if (!Number.isInteger(requiredConsecutiveDays) || requiredConsecutiveDays < 2) {
    throw new TypeError('requiredConsecutiveDays must be an integer of at least 2');
  }
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new TypeError('now() must return a valid Date');
  const today = calendarDate(current);
  const observations = entries.map((entry, index) => normalizeObservation(entry, index, today))
    .sort((left, right) => left.date.localeCompare(right.date));
  const dates = observations.map((observation) => observation.date);
  if (new Set(dates).size !== dates.length) {
    throw new TypeError(`Only one observation report is allowed per ${trendObservationTimeZone} calendar date`);
  }

  const baseline = observations[0];
  const baselineMarkets = JSON.stringify(baseline.requestedMarkets);
  for (const observation of observations.slice(1)) {
    if (observation.hours !== baseline.hours || JSON.stringify(observation.requestedMarkets) !== baselineMarkets) {
      throw new TypeError('All observation reports must use the same trend window and requested markets');
    }
  }

  const dateSet = new Set(dates);
  const missingDates = [];
  for (let date = dates[0]; date <= dates.at(-1); date = addDays(date, 1)) {
    if (!dateSet.has(date)) missingDates.push(date);
  }
  let longestConsecutiveRun = 1;
  let currentRun = 1;
  for (let index = 1; index < dates.length; index += 1) {
    currentRun = dayDifference(dates[index - 1], dates[index]) === 1 ? currentRun + 1 : 1;
    longestConsecutiveRun = Math.max(longestConsecutiveRun, currentRun);
  }

  const candidateMap = new Map();
  let candidateDays = 0;
  for (const observation of observations) {
    if (observation.candidates.length) candidateDays += 1;
    for (const candidate of observation.candidates) {
      let aggregate = candidateMap.get(candidate.dedupeKey);
      if (!aggregate) {
        aggregate = {
          dedupeKey: candidate.dedupeKey,
          title: candidate.title,
          titles: new Set(),
          tier: candidate.tier,
          dates: new Set(),
          reasons: new Set(),
          countries: new Set(),
          totalOccurrences: 0,
          maxTrafficLowerBound: null,
        };
        candidateMap.set(candidate.dedupeKey, aggregate);
      }
      if (aggregate.tier !== candidate.tier) {
        throw new TypeError(`Candidate identity changed across reports: ${candidate.dedupeKey}`);
      }
      aggregate.titles.add(candidate.title);
      aggregate.dates.add(observation.date);
      for (const reason of candidate.reasons) aggregate.reasons.add(reason);
      for (const country of candidate.countries) aggregate.countries.add(country);
      aggregate.totalOccurrences += candidate.occurrences;
      if (candidate.maxTrafficLowerBound !== null && (
        aggregate.maxTrafficLowerBound === null || candidate.maxTrafficLowerBound > aggregate.maxTrafficLowerBound
      )) aggregate.maxTrafficLowerBound = candidate.maxTrafficLowerBound;
    }
  }

  const candidates = [...candidateMap.values()].map((candidate) => ({
    dedupeKey: candidate.dedupeKey,
    title: candidate.title,
    titleVariants: [...candidate.titles].sort(),
    tier: candidate.tier,
    observedDays: candidate.dates.size,
    dates: [...candidate.dates].sort(),
    reasons: [...candidate.reasons].sort(),
    countries: [...candidate.countries].sort(),
    totalOccurrences: candidate.totalOccurrences,
    maxTrafficLowerBound: candidate.maxTrafficLowerBound,
    publicationEligible: false,
    nextAction: 'editorial-review-required',
  })).sort((left, right) => (
    right.observedDays - left.observedDays
    || right.totalOccurrences - left.totalOccurrences
    || left.title.localeCompare(right.title)
  ));

  return {
    schemaVersion: 1,
    source: {
      kind: 'watch-google-trends-longitudinal-summary',
      observationCount: observations.length,
      dateRange: { start: dates[0], end: dates.at(-1) },
      observedDates: dates,
      missingDates,
      hours: baseline.hours,
      requestedMarkets: baseline.requestedMarkets,
      requiredConsecutiveDays,
      calendarBasis: `${trendObservationTimeZone} date from trendingNow.source.lastUpdate`,
      calendarTimeZone: trendObservationTimeZone,
      inputs: observations.map(({ inputName, date, sourceUpdatedAt }) => ({ inputName, date, sourceUpdatedAt })),
    },
    summary: {
      longestConsecutiveRun,
      readyForEditorialEvaluation: longestConsecutiveRun >= requiredConsecutiveDays,
      noCandidateDays: observations.length - candidateDays,
      candidateDays,
      uniqueCandidateTitles: candidates.length,
      recurrentCandidateTitles: candidates.filter((candidate) => candidate.observedDays > 1).length,
    },
    policy: {
      autoPublish: false,
      decision: 'editorial-review-required',
      mixedRanking: false,
      notes: [
        `A complete observation window requires consecutive real ${trendObservationTimeZone} calendar dates; duplicate dates cannot inflate the count.`,
        'Fixed-keyword curves remain separate and are not aggregated into the RSS recurrence ranking.',
        'Readiness only permits editorial evaluation and never creates, translates or publishes content.',
      ],
    },
    candidates,
  };
}

function tableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderTrendLongitudinalMarkdown(report) {
  const lines = [
    '# Watch Google Trends Longitudinal Summary',
    '',
    `- Observation dates: ${report.source.dateRange.start} to ${report.source.dateRange.end}`,
    `- Reports: ${report.source.observationCount}`,
    `- Longest consecutive run: ${report.summary.longestConsecutiveRun} / ${report.source.requiredConsecutiveDays} days`,
    `- Missing dates: ${report.source.missingDates.length ? report.source.missingDates.join(', ') : 'none'}`,
    `- No-candidate days: ${report.summary.noCandidateDays}`,
    `- Editorial evaluation ready: ${report.summary.readyForEditorialEvaluation ? 'yes' : 'no'}`,
    '- Publication: disabled; readiness never triggers drafting or publishing.',
    '',
  ];
  if (!report.candidates.length) {
    lines.push('No core or adjacent candidate recurred in the observed reports.', '');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| Tier | Title | Observed days | Total occurrences | Countries | Max traffic floor |',
    '|---|---|---:|---:|---:|---:|',
  );
  for (const candidate of report.candidates) {
    lines.push(`| ${tableCell(candidate.tier)} | ${tableCell(candidate.title)} | ${candidate.observedDays} | ${candidate.totalOccurrences} | ${candidate.countries.length} | ${candidate.maxTrafficLowerBound ?? 'unknown'} |`);
  }
  lines.push('', 'All candidates remain `editorial-review-required`; fixed-keyword signals are not mixed into this table.', '');
  return `${lines.join('\n')}\n`;
}
