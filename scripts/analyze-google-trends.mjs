#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeGoogleTrendsKeywordCsv } from './lib/google-trends-keywords.mjs';
import { resolveExternalTrendOutput } from './lib/google-trends-rss.mjs';
import { analyzeTrendSnapshot } from './lib/trend-candidates.mjs';
import { composeTrendResearchReport, renderTrendResearchMarkdown } from './lib/trend-report.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage:
  npm run trends:analyze -- --input /absolute/path/to/all.json
  npm run trends:analyze -- --input /absolute/path/to/all.json --keyword-input /absolute/path/to/multiTimeline.csv --json
  npm run trends:analyze -- --input /absolute/path/to/all.json --output /tmp/watch-trends-report.md

This command does not fetch Google Trends, write site content, or publish pages.
When --output is used, it must be a new absolute path outside the repository.`;
const maxInputBytes = 25 * 1024 * 1024;

async function readBoundedFile(inputValue, label, maxBytes = maxInputBytes) {
  const input = path.resolve(inputValue);
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`${label} is not a regular file: ${input}`);
  if (inputStat.size > maxBytes) throw new Error(`${label} exceeds the safety limit: ${input}`);
  return { input, content: await readFile(input, 'utf8') };
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      'keyword-input': { type: 'string' },
      output: { type: 'string', short: 'o' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!values.input) throw new Error(`Missing --input.\n${usage}`);

  const output = values.output ? await resolveExternalTrendOutput(values.output, repo) : null;
  const rssInput = await readBoundedFile(values.input, 'RSS input');
  const trendingNow = analyzeTrendSnapshot(JSON.parse(rssInput.content));
  let keywordWatch = null;
  if (values['keyword-input']) {
    const keywordInput = await readBoundedFile(values['keyword-input'], 'Keyword input', 10 * 1024 * 1024);
    keywordWatch = analyzeGoogleTrendsKeywordCsv(keywordInput.content, { inputName: path.basename(keywordInput.input) });
  }
  const report = composeTrendResearchReport({ trendingNow, keywordWatch });
  const serialized = values.json ? `${JSON.stringify(report)}\n` : renderTrendResearchMarkdown(report);
  if (!output) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(output, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    output,
    format: values.json ? 'json' : 'markdown',
    candidateCount: report.signals.trendingNow.summary.candidateUniqueTitles,
    keywordSeriesCount: report.signals.keywordWatch?.source.seriesCount ?? 0,
    autoPublish: false,
  })}\n`);
}

main().catch((error) => {
  console.error(`[trends:analyze] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
