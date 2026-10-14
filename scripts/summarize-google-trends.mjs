#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveExternalTrendOutput } from './lib/google-trends-rss.mjs';
import { renderTrendLongitudinalMarkdown, summarizeTrendResearchReports } from './lib/trend-longitudinal.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const maxInputBytes = 25 * 1024 * 1024;
const usage = `Usage:
  npm run trends:summarize -- --input /absolute/day-01.json --input /absolute/day-02.json
  npm run trends:summarize -- --input /absolute/day-01.json --json
  npm run trends:summarize -- --input /absolute/day-01.json --output /tmp/watch-trends-longitudinal.md

Inputs must be schema-v2 JSON reports produced by trends:analyze. This command performs no network requests and cannot write inside the repository.`;

async function readReport(inputValue, index) {
  if (!path.isAbsolute(inputValue)) throw new TypeError(`--input[${index}] must be an absolute path`);
  const input = path.resolve(inputValue);
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`Input is not a regular file: ${input}`);
  if (inputStat.size > maxInputBytes) throw new Error(`Input exceeds the 25 MiB safety limit: ${input}`);
  let report;
  try {
    report = JSON.parse(await readFile(input, 'utf8'));
  } catch (error) {
    throw new TypeError(`Invalid JSON input ${input}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { inputName: path.basename(input), report };
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i', multiple: true },
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
  if (!values.input?.length) throw new Error(`At least one --input is required.\n${usage}`);
  const output = values.output ? await resolveExternalTrendOutput(values.output, repo) : null;
  const entries = [];
  for (const [index, input] of values.input.entries()) entries.push(await readReport(input, index));
  const report = summarizeTrendResearchReports(entries);
  const serialized = values.json ? `${JSON.stringify(report)}\n` : renderTrendLongitudinalMarkdown(report);
  if (!output) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(output, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    output,
    format: values.json ? 'json' : 'markdown',
    observationCount: report.source.observationCount,
    longestConsecutiveRun: report.summary.longestConsecutiveRun,
    readyForEditorialEvaluation: report.summary.readyForEditorialEvaluation,
    autoPublish: false,
  })}\n`);
}

main().catch((error) => {
  console.error(`[trends:summarize] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
