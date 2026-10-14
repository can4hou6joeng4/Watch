import { parse } from 'csv-parse/sync';

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizeCell(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function isEmptyRow(row) {
  return row.every((cell) => !normalizeCell(cell));
}

function isIsoDate(value) {
  const text = normalizeCell(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function parseSeriesLabel(value, index) {
  const label = nonEmptyString(value, `CSV header series[${index}]`);
  const match = label.match(/^(.*):\s*\(([^()]*)\)\s*$/u);
  return {
    id: `series-${index + 1}`,
    label,
    query: match ? match[1].trim() : label,
    scope: match ? match[2].trim() || null : null,
  };
}

function parseInterestValue(value, label) {
  const text = normalizeCell(value);
  if (/^<\s*1$/u.test(text)) {
    return { value: null, belowOne: true, raw: text };
  }
  if (!/^\d{1,3}$/u.test(text)) throw new TypeError(`${label} must be an integer from 0 to 100 or <1`);
  const numeric = Number(text);
  if (numeric < 0 || numeric > 100) throw new TypeError(`${label} must be between 0 and 100`);
  return { value: numeric, belowOne: false, raw: text };
}

function round(value) {
  return Number(value.toFixed(6));
}

function summarizeSeries(series, dates) {
  const numericPoints = series.points.filter((point) => point.value !== null);
  const numericValues = numericPoints.map((point) => point.value);
  const peak = numericPoints.reduce((current, point) => (
    !current || point.value > current.value ? point : current
  ), null);
  return {
    ...series,
    summary: {
      pointCount: series.points.length,
      numericPointCount: numericPoints.length,
      belowOneCount: series.points.filter((point) => point.belowOne).length,
      zeroCount: numericValues.filter((value) => value === 0).length,
      meanIndex: numericValues.length ? round(numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length) : null,
      peak: peak ? { date: peak.date, value: peak.value } : null,
      latest: series.points.at(-1) ?? null,
      dateRange: { start: dates[0], end: dates.at(-1) },
    },
  };
}

export function analyzeGoogleTrendsKeywordCsv(csv, { inputName = null } = {}) {
  const text = nonEmptyString(csv, 'Google Trends CSV');
  let rows;
  try {
    rows = parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
      trim: true,
    });
  } catch (error) {
    throw new TypeError(`Invalid Google Trends CSV: ${error instanceof Error ? error.message : String(error)}`);
  }

  const headerIndex = rows.findIndex((row, index) => {
    if (!Array.isArray(row) || row.length < 2 || isEmptyRow(row)) return false;
    const next = rows.slice(index + 1).find((candidate) => Array.isArray(candidate) && !isEmptyRow(candidate));
    return Boolean(next && isIsoDate(next[0]) && next.length >= row.length);
  });
  if (headerIndex < 0) throw new TypeError('Google Trends CSV does not contain a dated interest-over-time table');

  const header = rows[headerIndex].map(normalizeCell);
  const resolution = nonEmptyString(header[0], 'CSV date column');
  const seriesDefinitions = header.slice(1).map(parseSeriesLabel);
  if (new Set(seriesDefinitions.map((series) => series.label)).size !== seriesDefinitions.length) {
    throw new TypeError('Google Trends CSV series labels must be unique');
  }

  const metadataRows = rows.slice(0, headerIndex)
    .filter((row) => Array.isArray(row) && !isEmptyRow(row))
    .map((row) => row.map(normalizeCell));
  const pointsBySeries = seriesDefinitions.map((series) => ({ ...series, points: [] }));
  const dates = [];
  let started = false;
  for (const [offset, rawRow] of rows.slice(headerIndex + 1).entries()) {
    if (!Array.isArray(rawRow) || isEmptyRow(rawRow)) continue;
    const rowNumber = headerIndex + offset + 2;
    const row = rawRow.map(normalizeCell);
    if (!isIsoDate(row[0])) {
      if (started) throw new TypeError(`Unexpected non-date row at CSV row ${rowNumber}`);
      continue;
    }
    started = true;
    if (row.length !== header.length) {
      throw new TypeError(`CSV row ${rowNumber} has ${row.length} columns; expected ${header.length}`);
    }
    const date = row[0];
    if (dates.at(-1) && date <= dates.at(-1)) {
      throw new TypeError(`CSV dates must be strictly increasing; found ${date} after ${dates.at(-1)}`);
    }
    dates.push(date);
    for (const [index, value] of row.slice(1).entries()) {
      pointsBySeries[index].points.push({ date, ...parseInterestValue(value, `CSV row ${rowNumber} series ${index + 1}`) });
    }
  }
  if (dates.length < 2) throw new TypeError('Google Trends CSV must contain at least two dated points');

  return {
    schemaVersion: 1,
    source: {
      kind: 'google-trends-explore-csv',
      inputName,
      resolution,
      metadataRows,
      pointCount: dates.length,
      seriesCount: pointsBySeries.length,
      normalization: 'request-relative-0-100',
      comparisonScope: 'within-this-export-only',
    },
    policy: {
      autoPublish: false,
      decision: 'editorial-review-required',
      notes: [
        'Interest values are relative to the peak within this Google Trends request, not absolute search volume.',
        'Separate exports must not be compared as if their 0-100 scales were identical.',
        'Values reported as <1 remain low-volume markers and are not converted into invented numeric values.',
        'Series order follows the export and is not a content-priority ranking.',
      ],
    },
    series: pointsBySeries.map((series) => summarizeSeries(series, dates)),
  };
}

export function renderKeywordWatchMarkdown(report) {
  const lines = [
    '## Fixed Keyword Watch',
    '',
    `- Source: Google Trends Explore CSV (${report.source.resolution})`,
    `- Date range: ${report.series[0].summary.dateRange.start} to ${report.series[0].summary.dateRange.end}`,
    `- Data points: ${report.source.pointCount}`,
    '- Scale: request-relative 0-100; not search volume and not comparable across separate exports.',
    '- Publication: disabled; this signal cannot trigger publishing.',
    '',
    '| Query | Scope | Mean index | Peak | Latest | Below 1 | Zero points |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const series of report.series) {
    const peak = series.summary.peak ? `${series.summary.peak.value} (${series.summary.peak.date})` : 'unknown';
    const latest = series.summary.latest?.belowOne ? '<1' : (series.summary.latest?.value ?? 'unknown');
    lines.push(`| ${series.query.replaceAll('|', '\\|')} | ${(series.scope ?? 'unspecified').replaceAll('|', '\\|')} | ${series.summary.meanIndex ?? 'unknown'} | ${peak} | ${latest} | ${series.summary.belowOneCount} | ${series.summary.zeroCount} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
