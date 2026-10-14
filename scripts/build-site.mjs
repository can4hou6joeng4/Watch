import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { agents, content, defaultLocale, evidence, locales, maintainer, repo, samples, siteDate, siteUrl, siteVerification } from './lib/site-content.mjs';
import { alternatePagesFor, buildAllPageManifest, buildHomePageManifest, renderSitemap, validatePageManifest } from './lib/site-pages.mjs';
import { guides as authoredGuides } from './lib/site-guides.mjs';
import { loadLocaleDictionary, translateContent, translateGuideLocale } from './lib/apply-site-locale.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = path.join(root, 'scripts/lib/site-locales');
const authoredLocales = new Set(['zh', 'en']);
const activeLocaleList = process.env.WATCH_ALL_LOCALES ? Object.keys(locales) : ['zh', 'en'];
const publishedLocales = Object.fromEntries(Object.entries(locales).filter(([locale]) => {
  if (!activeLocaleList.includes(locale)) return false;
  if (authoredLocales.has(locale)) return true;
  return fs.existsSync(path.join(localeDir, `${locale}.json`));
}));
for (const locale of Object.keys(publishedLocales)) {
  if (authoredLocales.has(locale)) continue;
  const dictionary = loadLocaleDictionary(path.join(localeDir, `${locale}.json`));
  content[locale] = { ...translateContent(content.en, dictionary, locale), lang: publishedLocales[locale].hreflang };
}
const guides = authoredGuides.map((guide) => {
  const localized = { ...guide.locales };
  for (const locale of Object.keys(publishedLocales)) {
    if (authoredLocales.has(locale)) continue;
    localized[locale] = translateGuideLocale(guide.locales.en, loadLocaleDictionary(path.join(localeDir, `${locale}.json`)), locale);
  }
  return { ...guide, locales: localized };
});
const site = path.join(root, 'site');
const now = new Date();
const buildDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
const pageManifest = buildAllPageManifest({ siteUrl, locales: publishedLocales, published: '2026-09-12', modified: siteDate, guides });
validatePageManifest({ pages: pageManifest, siteUrl, locales: publishedLocales, defaultLocale, buildDate });
const esc = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}${icon('arrow-up-right')}</a>`;
const commands = {
  cli: ['git clone https://github.com/can4hou6joeng4/Watch.git', 'cd Watch && npm install', 'npm run watch -- status --json', 'npm run watch -- import-codex prepare <claude-id> --cwd /abs/project --desktop-project --experimental --json'],
  desktop: ['npm --prefix desktop install', 'npm run desktop:dev', 'cd desktop && npx tauri build'],
};
const languageMenu = (locale, group) => {
  const pages = pageManifest.filter((candidate) => candidate.alternateGroup === group);
  return `<details class="language-menu"><summary class="language-link">${icon('languages')}<span>${esc(content[locale].language)}</span></summary><div class="language-panel" role="list">${pages.map((candidate) => `<a role="listitem" href="${candidate.path}" lang="${publishedLocales[candidate.locale].hreflang}" hreflang="${publishedLocales[candidate.locale].hreflang}"${candidate.locale === locale ? ' aria-current="true"' : ''}>${esc(publishedLocales[candidate.locale].label)}</a>`).join('')}</div></details>`;
};
const hreflangLinks = (page) => {
  const alternates = alternatePagesFor(page, pageManifest, publishedLocales);
  const defaultPage = alternates.find((candidate) => candidate.locale === defaultLocale);
  return [...alternates.map((candidate) => `<link rel="alternate" hreflang="${publishedLocales[candidate.locale].hreflang}" href="${candidate.canonical}">`), `<link rel="alternate" hreflang="x-default" href="${defaultPage.canonical}">`].join('');
};
function renderPage(page) {
  const { locale } = page;
  const t = content[locale];
  const meta = publishedLocales[locale];
  const canonical = page.canonical;
  const ogImage = `${siteUrl}${meta.ogImage}`;
  const person = { '@type': 'Person', '@id': `${siteUrl}/#maintainer`, name: maintainer.name, url: maintainer.url, jobTitle: 'Developer', address: { '@type': 'PostalAddress', addressLocality: maintainer.locality, addressCountry: 'CN' }, sameAs: [siteUrl, maintainer.github, `${maintainer.github}/Homeport`] };
  const nav = [['simulator', 'workflow', t.demo], ['features', 'layers', t.mechanisms], ['compatibility', 'shield-check', t.compatibility], ['quickstart', 'terminal', t.quickstart], ['guides', 'file-text', t.guides], ['evidence', 'history', t.evidence], ['faq', 'circle-help', t.faq]];
  const jsonld = { '@context': 'https://schema.org', '@graph': [
    person,
    { '@type': 'WebSite', '@id': `${siteUrl}/#website`, url: `${siteUrl}/`, name: 'Watch', alternateName: ['AgentRelay', '值更', 'Watch · 值更'], inLanguage: Object.values(publishedLocales).map((item) => item.hreflang), publisher: { '@id': `${siteUrl}/#maintainer` } },
    { '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: t.title, description: t.description, inLanguage: t.lang, datePublished: page.published, dateModified: page.modified, isPartOf: { '@id': `${siteUrl}/#website` }, about: { '@id': `${siteUrl}/#app` }, mainEntity: { '@id': `${siteUrl}/#app` }, hasPart: [{ '@id': `${canonical}#faq` }], primaryImageOfPage: { '@type': 'ImageObject', url: ogImage, width: 1200, height: 630 }, ...(locale === defaultLocale ? {} : { translationOfWork: { '@id': `${pageManifest.find((candidate) => candidate.locale === defaultLocale && candidate.alternateGroup === page.alternateGroup).canonical}#webpage` } }) },
    { '@type': 'SoftwareApplication', '@id': `${siteUrl}/#app`, name: 'Watch', alternateName: ['AgentRelay', '值更', 'Watch · 值更'], url: `${siteUrl}/`, description: t.description, inLanguage: t.lang, applicationCategory: 'DeveloperApplication', applicationSubCategory: 'AI coding agent session handoff', operatingSystem: 'macOS', softwareVersion: '0.1.1', softwareRequirements: 'Node.js >= 22.13 (node:sqlite)', datePublished: '2026-09-12', dateModified: siteDate, isAccessibleForFree: true, license: `${repo}/blob/main/LICENSE`, downloadUrl: `${repo}/releases`, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, author: { '@id': `${siteUrl}/#maintainer` }, publisher: { '@id': `${siteUrl}/#maintainer` }, image: ogImage, featureList: ['Local session handoff across Claude Code, Codex, OpenCode, Kimi CLI, Grok and Pi', 'Strict working directory (cwd) verification avoiding worktree collision', 'OpenAI Codex Desktop single-session import with native writer lock probe', 'OpenCode SQLite relational store adapter with transaction rollback isolation', 'Direct text degradation for proprietary agent tool-call events'] },
    { '@type': 'SoftwareSourceCode', '@id': `${siteUrl}/#source`, name: 'Watch', codeRepository: repo, programmingLanguage: ['TypeScript', 'Rust'], runtimePlatform: 'Node.js >= 22.13', license: `${repo}/blob/main/LICENSE`, targetProduct: { '@id': `${siteUrl}/#app` }, author: { '@id': `${siteUrl}/#maintainer` } },
    { '@type': 'FAQPage', '@id': `${canonical}#faq`, url: `${canonical}#faq`, inLanguage: t.lang, isPartOf: { '@id': `${canonical}#webpage` }, mainEntity: t.faqs.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })) },
  ] };
  return `<!DOCTYPE html>
<html lang="${t.lang}">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t.title)}</title><meta name="description" content="${esc(t.description)}"><meta name="robots" content="index, follow">
  <meta name="author" content="${maintainer.name}">${Object.entries(siteVerification).map(([name, value]) => `<meta name="${name}" content="${value}">`).join('')}<link rel="canonical" href="${canonical}">${hreflangLinks(page)}
  <meta property="og:type" content="website"><meta property="og:site_name" content="${esc(t.siteName)}"><meta property="og:locale" content="${meta.ogLocale}">${Object.entries(publishedLocales).filter(([key]) => key !== locale).map(([, item]) => `<meta property="og:locale:alternate" content="${item.ogLocale}">`).join('')}<meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(t.ogAlt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(t.title)}"><meta name="twitter:description" content="${esc(t.description)}"><meta name="twitter:image" content="${ogImage}"><meta name="twitter:image:alt" content="${esc(t.ogAlt)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/style.css">
  <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
  <script src="/app.js" defer></script>
  <script src="/signal-field.js" defer></script>
  <script id="demoData" type="application/json">${JSON.stringify({ text: t, agents, samples }).replace(/</g, '\\u003c')}</script>
</head>
<body data-locale="${locale}">
  <a class="skip-link" href="#main">${t.skip}</a>
  <div class="site-content">
    <main id="main">
      <section class="signal-hero" aria-labelledby="hero-title">
        <canvas id="signalCanvas" aria-hidden="true"></canvas>
        <header class="site-topbar"><a class="brand" href="${meta.path}"><img class="brand-mark" src="/watch-mark.svg" alt="" width="30" height="15">Watch<span> / 值更</span></a><nav id="siteNav" aria-label="${t.workspace}">${nav.slice(0, 4).map(([id, name, text]) => `<a href="#${id}" class="nav-item"><span>${text}</span></a>`).join('')}</nav><div class="topbar-actions">${languageMenu(locale, page.alternateGroup)}${link(repo, 'GitHub')}<a class="nav-start" href="#quickstart">${t.start}</a><button class="icon-button mobile-menu" id="menuButton" aria-label="${t.menu}" aria-expanded="false" aria-controls="siteNav">${icon('menu')}</button></div><span id="currentSection" class="sr-only">${t.demo}</span></header>
        <div class="hero-content"><p class="eyebrow">${t.heroLabel}</p><h1 id="hero-title">${esc(t.h1)}<span class="h1-sub">${esc(t.h1Sub)}</span></h1><p class="hero-tagline">${t.intro}</p><p class="hero-detail">${t.heroDetail}</p><div class="hero-actions"><a href="#quickstart" class="primary-button">${t.start}${icon('arrow-up-right')}</a><a href="#simulator" class="secondary-button">${t.explore}${icon('arrow-right')}</a></div></div>
        <div class="hero-bottom"><span>CLAUDE / CODEX / OPENCODE / KIMI / PI / GROK</span><a href="#simulator">${t.scroll}${icon('arrow-down')}</a><span>MIT / v0.1.1</span></div>
      </section>
      <section id="simulator" class="site-section demo-section">
        <div class="page-heading"><div><span class="eyebrow">01 / SESSION CONTINUITY</span><h2>${t.demo}</h2><p>${t.introDetail}</p></div><span class="environment-label"><i class="status-dot"></i>${t.demoBadge}</span></div>
        <div class="workflow-strip">${t.stepLabels.map((label, index) => `<div class="workflow-item" data-step="${index}"><span class="step-index">0${index + 1}</span><span>${label}</span>${index < 3 ? icon('arrow-right') : ''}</div>`).join('')}</div>
        <div class="demo-workspace">
          <div class="source-column"><div class="section-heading"><h2>${t.source}</h2><span>01 / SOURCE</span></div>
            <label class="field-label" for="sampleSelect">${t.sample}</label><select id="sampleSelect">${t.sampleNames.map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select>
            <label class="field-label" for="sessionIdInput">${t.sessionId}</label><div class="session-search">${icon('search')}<input id="sessionIdInput" value="11111111-1111-4111-8111-111111111111" spellcheck="false" autocomplete="off"><button class="icon-button" id="resetDemo" title="${t.reset}" aria-label="${t.reset}">${icon('refresh-cw')}</button></div>
            <div class="source-identity"><img id="sourceIcon" src="/agents/claude.svg" alt=""><strong id="detectedAgent">Claude Code</strong><span class="badge blue">${t.online}</span></div>
            <div class="cwd-row">${icon('folder')}<code id="detectedCwd">/Users/dev/projects/example-api</code></div>
            <dl class="sample-metrics"><div><dt>${t.messages}</dt><dd id="detectedMessages">24</dd></div><div><dt>${t.tools}</dt><dd id="detectedTools">8</dd></div><div><dt>${t.status}</dt><dd class="text-metric" id="sourceStatus">${t.loaded}</dd></div></dl>
            <div class="context-section"><div class="section-heading"><h3>${t.context}</h3><span>SNAPSHOT</span></div><div class="excerpt-row"><span class="role-label">${t.user}</span><p>${t.userPrompt}</p></div><div class="excerpt-row"><span class="role-label blue">${t.assistant}</span><p>${t.assistantReply}</p></div><div class="tool-list"><span>TOOLS</span><code>Bash</code><code>Edit</code><code>Read</code></div></div>
          </div>
          <div class="target-column"><div class="section-heading"><h2>${t.target}</h2><span>02 / TARGET</span></div><div class="agent-selector" role="radiogroup" aria-label="${t.target}">${agents.map((agent) => `<button class="agent-option ${agent.id === 'codex' ? 'selected' : ''}" role="radio" aria-checked="${agent.id === 'codex'}" data-target="${agent.id}"><img src="/agents/${agent.id}.svg" alt=""><span>${agent.label}</span><span class="radio-indicator"></span></button>`).join('')}</div>
            <div class="handoff-tool"><div class="handoff-tool-heading"><span class="route-label">${icon('workflow')}<strong id="routeLabel">${t.official}</strong></span><span class="badge">DEMO</span></div><div class="handoff-tool-body"><p class="route-description" id="routeWarning">${t.officialWarning}</p><div class="delivery-row"><span>${t.delivery}</span><div class="segmented" role="group" aria-label="${t.delivery}"><button data-client="desktop" class="active">${icon('monitor')}${t.desktop}</button><button data-client="terminal">${icon('terminal')}${t.terminal}</button></div></div><div id="demoPlan" class="demo-plan" hidden><span>${t.planLabel}</span><code id="planId">demo-plan / example-api</code></div><div class="demo-actions"><button id="previewButton" class="primary-button">${t.preview}${icon('arrow-right')}</button><button id="confirmButton" class="primary-button" hidden>${t.confirm}${icon('check')}</button><button id="openButton" class="primary-button" hidden>${t.open}${icon('arrow-up-right')}</button><button id="restartButton" class="text-button">${icon('refresh-cw')}${t.reset}</button></div></div></div>
          </div>
        </div>
        <div class="demo-result"><div class="result-topline"><h2>${t.result}</h2><span id="pipelineStatus" class="badge">${t.waiting}</span></div><div class="result-tabs" role="tablist" aria-label="${t.result}"><button id="logsTab" role="tab" aria-selected="true" aria-controls="simLogs">${icon('list-checks')}${t.logs}</button><button id="structureTab" role="tab" aria-selected="false" aria-controls="simAst">${icon('code')}${t.structure}</button></div><div id="simLogs" role="tabpanel" aria-labelledby="logsTab" class="sim-log" aria-live="polite"><p>${t.logReady}</p></div><div id="simAst" role="tabpanel" aria-labelledby="structureTab" class="event-comparison" hidden><div><span>${t.eventSource}</span><pre id="sourceEvent"></pre></div><div><span>${t.eventTarget}</span><pre id="targetEvent"></pre></div></div><div class="command-output" id="commandOutput" hidden><span>$</span><code id="targetCommand"></code><button class="icon-button" id="copyTarget" title="${t.copy}" aria-label="${t.copy}">${icon('copy')}</button></div></div>
        <p class="demo-disclaimer">${icon('info')}${t.demoNotice}</p>
      </section>
      <section id="features" class="site-section"><div class="section-title"><span class="eyebrow">UNDER THE HOOD</span><h2>${t.mechanisms}</h2><p>${t.mechanismIntro}</p></div><div class="mechanism-grid">${t.mechanismItems.map(([name, title, body], index) => `<article class="mechanism-item"><span class="mechanism-icon">${icon(name)}</span><span class="item-index">0${index + 1}</span><h3>${title}</h3><p>${body}</p></article>`).join('')}</div></section>
      <section id="compatibility" class="site-section"><div class="section-title"><span class="eyebrow">ROUTE-SCOPED VALIDATION</span><h2>${t.compatibility}</h2><p>${t.compatibilityIntro}</p></div><div class="filter-bar" role="group" aria-label="${t.compatibility}">${[['all', t.all], ['limited', t.limited], ['pending', t.pending]].map(([value, label]) => `<button class="filter-button ${value === 'all' ? 'active' : ''}" data-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('')}<span>2026-09-10 / REPOSITORY</span></div><div class="table-scroll"><table class="compat-table"><thead><tr><th>${t.path}</th><th>${t.method}</th><th>${t.scope}</th><th>${t.status}</th></tr></thead><tbody>${t.paths.map(([route, method, scope, category, status]) => `<tr data-category="${category}"><td>${route}</td><td>${method}</td><td>${scope}</td><td><span class="badge ${category === 'limited' ? 'green' : 'amber'}">${status}</span></td></tr>`).join('')}</tbody></table></div><div class="section-bottom-link">${link(`${repo}/blob/main/docs/COMPATIBILITY.md`, 'COMPATIBILITY.md')}</div></section>
      <section id="guides" class="site-section"><div class="section-title"><span class="eyebrow">ANSWERS FIRST</span><h2>${t.guides}</h2><p>${t.guidesIntro}</p></div><div class="guide-index">${guides.filter((guide) => guide.status === 'published').map((guide) => { const item = guide.locales[locale]; const href = pageManifest.find((candidate) => candidate.guideId === guide.id && candidate.locale === locale).path; return `<article><h3><a href="${href}">${esc(item.h1)}</a></h3><p>${esc(item.answer)}</p><a class="guide-index-more" href="${href}">${t.readGuide}${icon('arrow-right')}</a></article>`; }).join('')}</div></section>
      <section id="quickstart" class="site-section"><div class="section-title"><span class="eyebrow">DEVELOPER WORKFLOW</span><h2>${t.quickstart}</h2><p>${t.quickIntro}</p></div><div class="quickstart-heading"><div class="segmented" role="tablist" aria-label="${t.quickstart}"><button id="cliTab" role="tab" aria-selected="true" aria-controls="cliCommands" data-quick="cli" class="active">${icon('terminal')}${t.cli}</button><button id="desktopTab" role="tab" aria-selected="false" aria-controls="desktopCommands" data-quick="desktop">${icon('monitor')}${t.desktopBuild}</button></div><span class="requirements">${t.requirements}</span></div>${Object.entries(commands).map(([key, list]) => `<div id="${key}Commands" class="command-list" role="tabpanel" aria-labelledby="${key === 'cli' ? 'cliTab' : 'desktopTab'}" ${key === 'desktop' ? 'hidden' : ''}>${list.map((command) => `<div class="command-row"><span>$</span><code>${esc(command)}</code><button class="icon-button" data-copy="${esc(command)}" title="${t.copy}" aria-label="${t.copy}">${icon('copy')}</button></div>`).join('')}<button class="text-button copy-group" data-copy="${esc(list.join('\n'))}">${icon('copy')}${t.copyAll}</button></div>`).join('')}<p class="troubleshooting">${icon('info')}${t.troubleshooting}</p></section>
      <section id="media" class="site-section"><div class="section-title"><span class="eyebrow">REAL OUTPUT / SYNTHETIC SESSIONS</span><h2>${t.media}</h2><p>${t.mediaIntro}</p></div><div class="media-grid"><figure><img src="/media/cli-claude-to-opencode.webp" alt="${esc(t.mediaItems[0][0])}" width="960" height="840" loading="lazy"><figcaption><strong>${esc(t.mediaItems[0][0])}</strong><span>${esc(t.mediaItems[0][1])}</span></figcaption></figure><figure><img src="/media/desktop-imported.webp" alt="${esc(t.mediaItems[1][0])}" width="1280" height="1120" loading="lazy"><figcaption><strong>${esc(t.mediaItems[1][0])}</strong><span>${esc(t.mediaItems[1][1])}</span></figcaption></figure></div></section>
      <section id="evidence" class="site-section"><div class="section-title"><span class="eyebrow">VERIFIABLE RECORDS</span><h2>${t.evidence}</h2><p>${t.evidenceIntro}</p></div><ol class="evidence-list">${evidence.map((item, index) => `<li><time datetime="${item.date}">${item.date}</time><div><h3>${t.evidenceTitles[index]}</h3><p>${t.evidenceDetails[index]}</p></div><span class="evidence-number">0${index + 1}</span></li>`).join('')}</ol></section>
      <section id="faq" class="site-section"><div class="section-title"><span class="eyebrow">QUESTIONS & BOUNDARIES</span><h2>${t.faq}</h2></div><div class="faq-list">${t.faqs.map(([question, answer]) => `<details><summary>${esc(question)}${icon('plus')}</summary><p>${esc(answer)}</p></details>`).join('')}</div></section>
      <section id="antigravity" class="site-section"><div class="section-title"><span class="eyebrow">OFFICIAL ENTRY / NOT INTEGRATED</span><h2>${t.antigravityTitle}</h2><p>${t.antigravityIntro}</p></div><p class="antigravity-status">${icon('info')}${t.antigravityStatus}</p><div class="antigravity-list">${t.antigravityItems.map(([title, command, detail], index) => `<article><span class="item-index">0${index + 1}</span><h3>${esc(title)}</h3><code>${esc(command)}</code><p>${esc(detail)}</p></article>`).join('')}</div><div class="antigravity-links">${link('https://antigravity.google/docs/cli/commands/resume', t.antigravityDocs)}</div></section>
    </main>
    <footer class="site-footer"><div class="footer-main"><div><strong>Watch · 值更</strong><p>${t.footerNote}</p></div><div><span class="nav-caption">${t.fleet}</span>${['Homeport', 'Watch', 'Atlas', 'Sonar', 'Semaphore'].map((name) => link(`https://github.com/can4hou6joeng4/${name}`, name)).join('')}</div><div><span class="nav-caption">${t.docs}</span>${guides.filter((guide) => guide.status === 'published').map((guide) => { const href = pageManifest.find((candidate) => candidate.guideId === guide.id && candidate.locale === page.locale).path; return `<a href="${href}">${esc(guide.locales[page.locale].h1)}</a>`; }).join('')}${link(`${repo}#readme`, 'README')}${link(`${repo}/blob/main/docs/import-codex.md`, 'Codex Import')}${link(`${repo}/blob/main/docs/ARCHITECTURE.md`, 'Architecture')}<a href="/sitemap.xml">Sitemap</a><a href="/robots.txt">Robots</a></div></div><div class="footer-bottom"><span>© 2026 can4hou6joeng4 · ${t.license}</span><span>${t.updated} / v0.1.1</span></div></footer>
  </div><div id="copyToast" class="copy-toast" role="status" aria-live="polite" hidden>${icon('check')}<span id="toastMessage"></span></div>
  <noscript><p class="noscript-note">${t.demoNotice} JavaScript is required for the synthetic demo. All project information is available below.</p></noscript>
</body></html>`;
}

function renderGuidePage(page) {
  const { locale, guideId } = page;
  const guide = guides.find((g) => g.id === guideId);
  const t = content[locale];
  const g = guide.locales[locale];
  const meta = publishedLocales[locale];
  const canonical = page.canonical;
  const ogImage = `${siteUrl}${meta.ogImage}`;
  const person = {
    '@type': 'Person',
    '@id': `${siteUrl}/#maintainer`,
    name: maintainer.name,
    url: maintainer.url,
    jobTitle: 'Developer',
    address: { '@type': 'PostalAddress', addressLocality: maintainer.locality, addressCountry: 'CN' },
    sameAs: [siteUrl, maintainer.github, `${maintainer.github}/Homeport`]
  };

  const breadcrumbs = [
    { name: t.crumbHome, url: meta.path },
    { name: t.guides, url: `${meta.path}#guides` },
    { name: g.h1, url: canonical }
  ];

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      person,
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: `${siteUrl}/`,
        name: 'Watch',
        alternateName: ['AgentRelay', '值更', 'Watch · 值更'],
        inLanguage: Object.values(publishedLocales).map((item) => item.hreflang),
        publisher: { '@id': `${siteUrl}/#maintainer` }
      },
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: g.title,
        description: g.description,
        inLanguage: meta.hreflang,
        datePublished: page.published,
        dateModified: page.modified,
        isPartOf: { '@id': `${siteUrl}/#website` },
        mainEntity: { '@id': `${canonical}#article` },
        primaryImageOfPage: { '@type': 'ImageObject', url: ogImage, width: 1200, height: 630 },
        ...(locale === defaultLocale ? {} : {
          translationOfWork: {
            '@id': `${pageManifest.find((candidate) => candidate.locale === defaultLocale && candidate.alternateGroup === page.alternateGroup).canonical}#webpage`
          }
        })
      },
      {
        '@type': 'TechArticle',
        '@id': `${canonical}#article`,
        url: canonical,
        headline: g.h1,
        description: g.description,
        inLanguage: meta.hreflang,
        datePublished: page.published,
        dateModified: page.modified,
        isPartOf: { '@id': `${siteUrl}/#website` },
        mainEntityOfPage: canonical,
        author: { '@id': `${siteUrl}/#maintainer` },
        publisher: { '@id': `${siteUrl}/#maintainer` },
        image: ogImage
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: breadcrumbs.map((crumb, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          name: crumb.name,
          item: crumb.url.startsWith('http') ? crumb.url : `${siteUrl}${crumb.url}`
        }))
      },
      ...(g.faq && g.faq.length > 0 ? [{
        '@type': 'FAQPage',
        '@id': `${canonical}#faq`,
        url: `${canonical}#faq`,
        inLanguage: meta.hreflang,
        isPartOf: { '@id': `${canonical}#webpage` },
        mainEntity: g.faq.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: item.answer }
        }))
      }] : []),
      ...(g.blocks.some((b) => b.type === 'steps') ? [{
        '@type': 'HowTo',
        '@id': `${canonical}#howto`,
        name: g.h1,
        description: g.description,
        inLanguage: meta.hreflang,
        isPartOf: { '@id': `${canonical}#webpage` },
        step: g.blocks.find((b) => b.type === 'steps').items.map((step, idx) => ({
          '@type': 'HowToStep',
          position: idx + 1,
          name: step.title,
          text: step.body,
          url: `${canonical}#step-${idx + 1}`
        }))
      }] : [])
    ]
  };

  const renderBlock = (block) => {
    switch (block.type) {
      case 'paragraph':
        return `<p class="guide-paragraph">${esc(block.text)}</p>`;
      case 'callout':
        return `<div class="guide-callout ${block.tone}"><strong>${esc(block.title)}</strong><p>${esc(block.body)}</p></div>`;
      case 'steps':
        return `<ol class="guide-steps">${block.items.map((item, idx) => `<li id="step-${idx + 1}"><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p></li>`).join('')}</ol>`;
      case 'code':
        return `<div class="command-list"><div class="command-row"><code>${esc(block.code)}</code><button class="icon-button" data-copy="${esc(block.code)}" title="${t.copy}" aria-label="${t.copy}">${icon('copy')}</button></div></div>`;
      case 'table':
        return `<div class="table-scroll"><table class="compat-table"><thead><tr>${block.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      default:
        return '';
    }
  };

  const faqSection = g.faq && g.faq.length > 0 ? `
    <section class="guide-faq">
      <h2>${esc(t.guideFaq)}</h2>
      <div class="faq-list">
        ${g.faq.map((item) => `<details><summary>${esc(item.question)}${icon('plus')}</summary><p>${esc(item.answer)}</p></details>`).join('')}
      </div>
    </section>
  ` : '';

  const sourcesSection = g.sources && g.sources.length > 0 ? `
    <section class="guide-sources">
      <h2>${esc(t.guideSources)}</h2>
      <ul>
        ${g.sources.map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.label)}</a> <span class="eyebrow">(Checked ${esc(src.accessed)})</span></li>`).join('')}
      </ul>
    </section>
  ` : '';

  return `<!DOCTYPE html>
<html lang="${meta.hreflang}">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(g.title)}</title><meta name="description" content="${esc(g.description)}"><meta name="robots" content="index, follow">
  <meta name="author" content="${maintainer.name}">${Object.entries(siteVerification).map(([name, value]) => `<meta name="${name}" content="${value}">`).join('')}<link rel="canonical" href="${canonical}">${hreflangLinks(page)}
  <meta property="og:type" content="article"><meta property="og:site_name" content="${esc(t.siteName)}"><meta property="og:locale" content="${meta.ogLocale}">${Object.entries(publishedLocales).filter(([key]) => key !== locale).map(([, item]) => `<meta property="og:locale:alternate" content="${item.ogLocale}">`).join('')}<meta property="og:title" content="${esc(g.title)}"><meta property="og:description" content="${esc(g.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(g.title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(g.title)}"><meta name="twitter:description" content="${esc(g.description)}"><meta name="twitter:image" content="${ogImage}"><meta name="twitter:image:alt" content="${esc(g.title)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/style.css">
  <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
  <script src="/app.js" defer></script>
</head>
<body data-locale="${locale}">
  <a class="skip-link" href="#main">${t.skip}</a>
  <div class="site-content">
    <header class="site-topbar"><a class="brand" href="${meta.path}"><img class="brand-mark" src="/watch-mark.svg" alt="" width="30" height="15">Watch<span> / 值更</span></a><div class="topbar-actions"><a href="${meta.path}" class="nav-item"><span>${esc(t.backHome)}</span></a>${languageMenu(locale, page.alternateGroup)}${link(repo, 'GitHub')}</div></header>
    <main id="main" class="guide-container">
      <nav class="guide-breadcrumbs" aria-label="Breadcrumb">
        <a href="${meta.path}">${esc(t.crumbHome)}</a>
        <span>/</span>
        <a href="${meta.path}#guides">${esc(t.guides)}</a>
        <span>/</span>
        <span aria-current="page">${esc(g.h1)}</span>
      </nav>
      <header class="guide-header">
        <span class="eyebrow">${esc(t.guideEyebrow)}</span>
        <h1>${esc(g.h1)}</h1>
        <p class="guide-answer">${esc(g.answer)}</p>
        <p class="guide-summary">${esc(g.summary)}</p>
        <div class="guide-meta">
          <span>${esc(t.published)}: ${page.published}</span>
          <span>${esc(t.modified)}: ${page.modified}</span>
          <span>${esc(t.appliesTo)}: Watch v0.1.1</span>
        </div>
      </header>
      <article class="guide-content">
        ${g.blocks.map(renderBlock).join('\n')}
      </article>
      ${faqSection}
      ${sourcesSection}
      <div class="guide-nav-footer">
        <a href="${meta.path}" class="secondary-button">${icon('arrow-right')}${esc(t.returnHome)}</a>
        ${link(`${repo}/releases`, t.downloadDesktop)}
      </div>
    </main>
    <footer class="site-footer"><div class="footer-main"><div><strong>Watch · 值更</strong><p>${t.footerNote}</p></div><div><span class="nav-caption">${t.fleet}</span>${['Homeport', 'Watch', 'Atlas', 'Sonar', 'Semaphore'].map((name) => link(`https://github.com/can4hou6joeng4/${name}`, name)).join('')}</div><div><span class="nav-caption">${t.docs}</span>${guides.filter((guide) => guide.status === 'published').map((guide) => { const href = pageManifest.find((candidate) => candidate.guideId === guide.id && candidate.locale === locale).path; return `<a href="${href}">${esc(guide.locales[locale].h1)}</a>`; }).join('')}${link(`${repo}#readme`, 'README')}${link(`${repo}/blob/main/docs/import-codex.md`, 'Codex Import')}${link(`${repo}/blob/main/docs/ARCHITECTURE.md`, 'Architecture')}<a href="/sitemap.xml">Sitemap</a><a href="/robots.txt">Robots</a></div></div><div class="footer-bottom"><span>© 2026 can4hou6joeng4 · ${t.license}</span><span>${t.updated} / v0.1.1</span></div></footer>
  </div>
  <div id="copyToast" class="copy-toast" role="status" aria-live="polite" hidden>${icon('check')}<span id="toastMessage"></span></div>
</body>
</html>`;
}

const require = createRequire(path.join(root, 'desktop/package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const lucide = require('lucide-react');
const names = ['Workflow', 'ArrowUpRight', 'ArrowRight', 'ArrowDown', 'Layers', 'ShieldCheck', 'Terminal', 'History', 'CircleHelp', 'Menu', 'Languages', 'Search', 'RefreshCw', 'Folder', 'Monitor', 'Check', 'ListChecks', 'Code', 'Copy', 'Info', 'Plus', 'FileText'];
const toId = (name) => name.replace(/[A-Z]/g, (char, index) => `${index ? '-' : ''}${char.toLowerCase()}`);
const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${names.map((name) => renderToStaticMarkup(React.createElement(lucide[name], { id: toId(name), width: 24, height: 24, strokeWidth: 1.7 }))).join('')}</defs></svg>`;
const renderedPages = pageManifest.map((page) => ({ page, html: page.guideId ? renderGuidePage(page) : renderPage(page) }));
for (const { page, html } of renderedPages) {
  if ((html.match(/<h1\b/g) ?? []).length !== 1) throw new Error(`[site-build] ${page.id} must contain exactly one h1`);
  if (page.guideId) {
    const answer = guides.find((guide) => guide.id === page.guideId).locales[page.locale].answer;
    if (!answer) throw new Error(`[site-build] ${page.id} is missing a citable answer`);
    if (!html.includes(`<p class="guide-answer">${esc(answer)}</p>`)) throw new Error(`[site-build] ${page.id} answer is not the opening paragraph`);
  } else {
    const main = html.slice(html.indexOf('<main'), html.indexOf('<footer'));
    for (const guide of guides.filter((guide) => guide.status === 'published')) {
      const href = pageManifest.find((candidate) => candidate.guideId === guide.id && candidate.locale === page.locale).path;
      if (!main.includes(`href="${href}"`)) throw new Error(`[site-build] ${page.id} main content does not link ${href}`);
    }
  }
  if (!html.includes(`<link rel="canonical" href="${page.canonical}">`)) throw new Error(`[site-build] ${page.id} canonical is missing`);
  for (const alternate of alternatePagesFor(page, pageManifest, publishedLocales)) {
    const expected = `<link rel="alternate" hreflang="${publishedLocales[alternate.locale].hreflang}" href="${alternate.canonical}">`;
    if (!html.includes(expected)) throw new Error(`[site-build] ${page.id} is missing alternate ${alternate.locale}`);
  }
  const defaultPage = pageManifest.find((candidate) => candidate.locale === defaultLocale && candidate.alternateGroup === page.alternateGroup);
  if (!html.includes(`<link rel="alternate" hreflang="x-default" href="${defaultPage.canonical}">`)) {
    throw new Error(`[site-build] ${page.id} is missing x-default`);
  }
}
const sitemap = renderSitemap({ pages: pageManifest, siteUrl, locales: publishedLocales, defaultLocale, buildDate });

const writeIfChanged = (dest, content) => {
  if (fs.existsSync(dest)) {
    const cur = fs.readFileSync(dest);
    const target = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (cur.equals(target)) return;
  }
  fs.writeFileSync(dest, content);
};

fs.mkdirSync(path.join(site, 'agents'), { recursive: true });
for (const agent of agents) {
  const dest = path.join(site, `agents/${agent.id}.svg`);
  const src = path.join(root, `desktop/public/${agent.id}.svg`);
  writeIfChanged(dest, fs.readFileSync(src));
}
writeIfChanged(path.join(site, 'icons.svg'), sprite);
writeIfChanged(path.join(site, 'style.css'), fs.readFileSync(path.join(site, 'input.css')));
for (const { page, html } of renderedPages) {
  const dir = path.join(site, page.path.slice(1));
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, 'index.html'), html);
}
const notFound = Object.entries(publishedLocales).map(([locale, meta]) => { const t = content[locale]; return `<section lang="${meta.hreflang}"><span class="eyebrow">404 / NOT FOUND</span><h1>${t.notFound}</h1><p>${t.notFoundText}</p><a href="${meta.path}" class="primary-button">${t.back}${icon('arrow-right')}</a></section>`; }).join('');
writeIfChanged(path.join(site, '404.html'), `<!DOCTYPE html><html lang="${publishedLocales.zh.hreflang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>404 · Watch</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"></head><body class="not-found"><a class="brand" href="/"><img class="brand-mark" src="/watch-mark.svg" alt="" width="30" height="15">Watch</a><main>${notFound}</main></body></html>`);
writeIfChanged(path.join(site, 'sitemap.xml'), sitemap);
function generateLlmsFull({ guides, siteUrl, maintainer, siteDate }) {
  const lines = [
    '# Watch · 值更 (AgentRelay) — Full Context for AI Search & LLMs',
    '',
    `> Canonical Site: ${siteUrl}/ (zh-CN) | ${siteUrl}/en/ (en)`,
    `> Author: ${maintainer.name} (${maintainer.url})`,
    `> Generated: ${siteDate}. License: MIT`,
    '',
    '---',
    '',
    '## 1. Core System & Overview',
    '',
    'Watch (Chinese: 值更, also called AgentRelay) is a free, local-only CLI and macOS desktop tool that hands an in-progress AI coding-agent session (conversation history, tool call events, and exact working directory) between Claude Code, OpenAI Codex, OpenCode, Kimi CLI, Pi and Grok CLI when an agent hits account usage limits or gets stuck.',
    '',
    '### Key Safety Constraints',
    '- 100% Local Execution: Watch has no cloud relay, server, or analytics. It reads and writes local disk stores directly.',
    '- Strict CWD Matching: Prevents code edits across different workspaces or Git worktrees.',
    '- Target Writer Guard: Direct writes to Codex inspect native per-thread writer locks (~/.codex/thread-writer-locks/<id>.lock via lsof) and pre/post content fingerprints.',
    '- OpenCode SQLite Isolation: Multi-table writes (sessions, messages, parts) execute in one SQLite transaction and roll back on failure; supports WATCH_OPENCODE_DB isolation.',
    '- Tool Call Degradation: Complex proprietary tool call events are downgraded to structured text representations in target agents.',
    '',
    '---',
    '',
    '## 2. Intent-to-Route Decision Matrix',
    '',
    '| User Intent / Failure Scenario | Source Agent | Target Agent | Handoff Route | Primary Command | Data Preservation & Safety |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    '| 5-hour / weekly usage limit reached | Claude Code | OpenAI Codex | Official Desktop Import | `npm run watch -- import-codex prepare <id> --desktop-project` | Target writer lock probe; tool calls degrade to text; CWD strictly verified |',
    '| Context window full (200k tokens) | Claude Code | Claude Code | Native `/compact` | `/compact` (in Claude) | Handled natively inside Claude Code; no tool switch required |',
    '| Switch to local offline model | Claude Code | OpenCode | SQLite Store Adapter | `npm run watch -- open <id> --to opencode` | Single SQLite transaction rollback on failure; custom DB via WATCH_OPENCODE_DB |',
    '| Opus 5.5 limit after saved reset | Claude Code | OpenAI Codex | Official Desktop Import | `npm run watch -- import-codex prepare <id>` | Official reset token consumed; preserve investigation context |',
    '| Resume past session in original agent | Any | Same Agent | Native Resume | `claude --resume <id>` / `codex resume <id>` / `opencode -s <id>` | Native CLI history lookup; no translation required |',
    '',
    '---',
    '',
    '## 3. Technical Guides (Full Text & Official Procedures)',
    ''
  ];

  for (const guide of guides) {
    const zh = guide.locales.zh;
    const en = guide.locales.en;
    lines.push(`### Guide: ${en.h1} (${zh.h1})`);
    lines.push(`- URL (zh): ${siteUrl}/guides/${zh.slug}/`);
    lines.push(`- URL (en): ${siteUrl}/en/guides/${en.slug}/`);
    lines.push(`- Direct Answer (en): ${en.answer}`);
    lines.push(`- 核心解答 (zh): ${zh.answer}`);
    lines.push('');
    lines.push('#### Procedure Steps:');
    const steps = en.blocks.find((b) => b.type === 'steps');
    if (steps) {
      for (const item of steps.items) {
        lines.push(`1. **${item.title}**: ${item.body}`);
      }
    }
    lines.push('');
    lines.push('#### Frequently Asked Questions:');
    if (en.faq) {
      for (const q of en.faq) {
        lines.push(`- **Q: ${q.question}**`);
        lines.push(`  A: ${q.answer}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

writeIfChanged(path.join(site, 'llms-full.txt'), generateLlmsFull({ guides, siteUrl, maintainer, siteDate }));
const headers = fs.readFileSync(path.join(site, '_headers'), 'utf8').split(/\n(?=\/)/).filter((block) => !/^\/[a-z-]+\/\*\n  ! Content-Language/.test(block)).join('\n').trimEnd();
writeIfChanged(path.join(site, '_headers'), `${headers}\n${Object.entries(publishedLocales).filter(([locale]) => publishedLocales[locale].path !== '/').map(([, meta]) => `\n${meta.path}*\n  ! Content-Language\n  Content-Language: ${meta.hreflang}`).join('')}\n`);
console.log(`Generated ${pageManifest.length} canonical pages, sitemap, 404, llms-full.txt, shared CSS, Lucide sprites and provider assets.`);

