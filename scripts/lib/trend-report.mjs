import { renderKeywordWatchMarkdown } from './google-trends-keywords.mjs';
import { renderTrendCandidateMarkdown } from './trend-candidates.mjs';

export function composeTrendResearchReport({ trendingNow, keywordWatch = null }) {
  if (!trendingNow || typeof trendingNow !== 'object') throw new TypeError('trendingNow report is required');
  if (keywordWatch !== null && typeof keywordWatch !== 'object') throw new TypeError('keywordWatch must be an object or null');
  return {
    schemaVersion: 2,
    signals: {
      trendingNow,
      keywordWatch,
    },
    policy: {
      autoPublish: false,
      decision: 'editorial-review-required',
      mixedRanking: false,
      notes: [
        'Trending Now RSS candidates and fixed-keyword interest curves are separate signals.',
        'No shared score or ranking is computed across the two signal types.',
        'Neither signal may create, edit, translate or publish site content automatically.',
      ],
    },
  };
}

export function renderTrendResearchMarkdown(report) {
  const trending = renderTrendCandidateMarkdown(report.signals.trendingNow)
    .replace('# Watch Google Trends Candidate Report', '# Watch Google Trends Research Report\n\n## Trending Now RSS');
  if (!report.signals.keywordWatch) {
    return `${trending}\n## Fixed Keyword Watch\n\nNo Google Trends Explore CSV was provided. RSS candidates remain separate from fixed-keyword monitoring.\n`;
  }
  return `${trending}\n${renderKeywordWatchMarkdown(report.signals.keywordWatch)}`;
}
