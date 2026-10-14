#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  allowedTrendHours,
  buildGoogleTrendsRssUrl,
  collectGoogleTrendsRss,
  resolveExternalTrendOutput,
  selectTrendMarkets,
  trendCollectionPolicy,
} from './lib/google-trends-rss.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage:
  npm run trends:collect -- --plan
  npm run trends:collect -- --output /tmp/watch-trends.json
  npm run trends:collect -- --markets TW,HK,SG,US --hours 48 --json

The collector is read-only upstream, sequential, has no retries, and cannot write inside the repository.`;

function parseHours(value) {
  const hours = Number(value ?? trendCollectionPolicy.defaultHours);
  if (!Number.isInteger(hours) || !allowedTrendHours.includes(hours)) {
    throw new TypeError(`--hours must be one of: ${allowedTrendHours.join(', ')}`);
  }
  return hours;
}

async function main() {
  const { values } = parseArgs({
    options: {
      markets: { type: 'string' },
      hours: { type: 'string', default: String(trendCollectionPolicy.defaultHours) },
      output: { type: 'string', short: 'o' },
      json: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const markets = selectTrendMarkets(values.markets);
  const hours = parseHours(values.hours);
  if (values.plan) {
    if (values.output) throw new TypeError('--plan cannot be combined with --output');
    const plan = {
      markets: markets.map((market) => ({ ...market, sourceUrl: buildGoogleTrendsRssUrl(market, hours) })),
      hours,
      policy: trendCollectionPolicy,
    };
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  const output = values.output ? await resolveExternalTrendOutput(values.output, repo) : null;
  const snapshot = await collectGoogleTrendsRss({ markets, hours });
  const serialized = values.json ? JSON.stringify(snapshot) : JSON.stringify(snapshot, null, 2);
  if (!output) {
    process.stdout.write(`${serialized}\n`);
    return;
  }
  await writeFile(output, `${serialized}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ output, countries: snapshot.countries, collectedAt: snapshot.lastUpdate })}\n`);
}

main().catch((error) => {
  console.error(`[trends:collect] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
