import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { content } from '../scripts/lib/site-content.mjs';

test('localized site pages preserve all sections and accurate demo boundaries', () => {
  for (const [locale, file] of [['zh', 'site/index.html'], ['en', 'site/en/index.html']] as const) {
    const html = readFileSync(file, 'utf8');
    for (const id of ['simulator', 'features', 'compatibility', 'quickstart', 'evidence', 'faq']) assert.ok(html.includes(`id="${id}"`), `${file}: ${id}`);
    assert.ok(html.includes('rel="canonical"'));
    assert.ok(html.includes('hreflang="en"'));
    assert.ok(html.includes('hreflang="zh-CN"'));
    const data = JSON.parse(html.match(/<script id="demoData" type="application\/json">(.*?)<\/script>/s)![1]);
    assert.equal(data.text.lang, content[locale].lang);
    assert.equal(data.agents.length, 5);
    assert.equal(data.samples.length, 3);
    assert.ok(html.includes(content[locale].demoNotice));
    assert.ok(html.includes(content[locale].officialWarning));
    assert.ok(html.includes('aria-controls="simLogs"'));
    assert.ok(!html.includes('fonts.googleapis.com'));
  }
  for (const file of ['site/index.html', 'site/en/index.html']) {
    assert.ok(!readFileSync(file, 'utf8').includes('docs/evidence/'), `${file} must not link undistributed evidence records`);
  }
});
test('static assets and icon viewports are available without remote dependencies', () => {
  const html = readFileSync('site/index.html', 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/[^"#]+)(?:#[^"]*)?"/g)) {
    if (match[1] === '/' || match[1].endsWith('/')) continue;
    assert.ok(existsSync(`site${match[1]}`), match[1]);
  }
  for (const match of html.matchAll(/<svg([^>]*)>/g)) assert.ok(match[1].includes('viewBox="0 0 24 24"'));
  const css = readFileSync('site/input.css', 'utf8');
  assert.equal(readFileSync('site/style.css', 'utf8'), css);
  assert.ok(css.includes('[hidden] { display: none !important; }'));
  assert.ok(!css.includes('@tailwind'));
});

test('Signal Ledger site uses a local full-bleed hero while preserving Watch content', () => {
  for (const file of ['site/index.html', 'site/en/index.html']) {
    const html = readFileSync(file, 'utf8');
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    assert.ok(html.includes('class="signal-hero"'));
    assert.ok(html.includes('id="signalCanvas"'));
    assert.ok(html.includes('src="/signal-field.js"'));
    assert.ok(!html.includes('site-sidebar'));
    assert.ok(!html.includes('cdn.tailwindcss.com'));
    assert.ok(!html.includes('Live agent telemetry'));
    assert.ok(html.includes('href="#quickstart"'));
    assert.ok(html.includes('href="#simulator"'));
  }
  const field = readFileSync('site/signal-field.js', 'utf8');
  for (const boundary of ['prefers-reduced-motion', 'IntersectionObserver', 'document.hidden', 'visibilitychange', 'cancelAnimationFrame']) assert.ok(field.includes(boundary), boundary);
  assert.ok(!field.includes('fetch('));
});

test('Antigravity documentation does not become a Watch transfer target', () => {
  for (const [locale, file] of [['zh', 'site/index.html'], ['en', 'site/en/index.html']] as const) {
    const html = readFileSync(file, 'utf8');
    assert.ok(html.includes('id="antigravity"'));
    assert.ok(html.includes(content[locale].antigravityTitle));
    assert.ok(html.includes(content[locale].antigravityStatus));
    assert.ok(html.includes('agy --conversation &lt;conversation-id&gt;'));
    assert.ok(html.includes('<code>agy -c</code>'));
    assert.ok(html.includes('<code>/resume</code>'));
    const data = JSON.parse(html.match(/<script id="demoData" type="application\/json">(.*?)<\/script>/s)![1]);
    assert.equal(data.agents.length, 5);
    assert.ok(!data.agents.some((agent: { id: string }) => agent.id === 'antigravity'));
    assert.ok(!html.includes('data-target="antigravity"'));
    assert.equal(content[locale].antigravityItems.length, 3);
  }
});
