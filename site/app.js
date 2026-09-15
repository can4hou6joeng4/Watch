(() => {
  'use strict';
  const { text: t, samples, agents } = JSON.parse(document.getElementById('demoData').textContent);
  const $ = (id) => document.getElementById(id);
  const targetId = '22222222-2222-4222-8222-222222222222';
  let sample = samples[0];
  let target = 'codex';
  let client = 'desktop';
  let state = 'idle';
  let toastTimer;
  const label = (id) => agents.find((agent) => agent.id === id)?.label || id;
  const route = () => sample?.provider === target ? 'resume' : sample?.provider === 'claude' && target === 'codex' ? 'official' : 'conversion';
  function log(text) { const line = document.createElement('p'); line.textContent = text; $('simLogs').appendChild(line); }
  function showToast(text) { clearTimeout(toastTimer); $('toastMessage').textContent = text; $('copyToast').hidden = false; toastTimer = setTimeout(() => { $('copyToast').hidden = true; }, 3000); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); showToast(t.copied); }
    catch {
      const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      try { if (!document.execCommand('copy')) throw new Error('Copy unavailable'); showToast(t.copied); } catch { showToast(t.copyError); }
      area.remove();
    }
  }
  function renderEvents() {
    $('sourceEvent').textContent = JSON.stringify({ provider: sample?.provider || 'unknown', event: 'tool_call', name: 'Edit', input: { file: 'src/api.ts' } }, null, 2);
    $('targetEvent').textContent = JSON.stringify({ provider: target, representation: route() === 'official' ? 'text (degraded)' : 'adapter-dependent', example: 'Edit: src/api.ts', nativeSchema: false }, null, 2);
  }
  function update() {
    const currentRoute = route();
    $('routeLabel').textContent = t[currentRoute === 'official' ? 'official' : currentRoute === 'resume' ? 'resume' : 'conversion'];
    $('routeWarning').textContent = !sample ? t.unknownNotice : currentRoute === 'official' ? t.officialWarning : t.baselineWarning;
    document.querySelectorAll('[data-client]').forEach((button) => {
      button.disabled = button.dataset.client === 'desktop' && currentRoute !== 'official';
      button.classList.toggle('active', button.dataset.client === client); button.setAttribute('aria-pressed', String(button.dataset.client === client));
    });
    document.querySelectorAll('[data-target]').forEach((button) => { const selected = button.dataset.target === target; button.classList.toggle('selected', selected); button.setAttribute('aria-checked', String(selected)); });
    $('previewButton').hidden = state !== 'idle'; $('previewButton').disabled = !sample;
    $('confirmButton').hidden = state !== 'prepared'; $('openButton').hidden = state !== 'imported';
    $('demoPlan').hidden = state === 'idle';
    $('pipelineStatus').textContent = !sample ? t.unknown : t[{ idle: 'waiting', prepared: 'prepared', imported: 'imported', opened: 'opened' }[state]];
    $('pipelineStatus').classList.toggle('green', state === 'imported' || state === 'opened');
    $('commandOutput').hidden = state !== 'imported' && state !== 'opened';
    if (!$('commandOutput').hidden) {
      const id = currentRoute === 'resume' ? sample.id : targetId;
      const commands = { claude: `claude --resume ${id}`, codex: `codex resume ${id}`, opencode: `opencode -s ${id}`, kimi: `kimi -r ${id}`, pi: `pi --session ${id}` };
      $('targetCommand').textContent = `cd '${sample.cwd}' && ${commands[target]}`;
    }
    document.querySelectorAll('[data-step]').forEach((item) => { const index = Number(item.dataset.step); item.classList.toggle('complete', sample && (index < 2 || index === 2 && state !== 'idle' || index === 3 && (state === 'imported' || state === 'opened'))); });
    renderEvents();
  }
  function reset() { state = 'idle'; $('simLogs').replaceChildren(); log(t.logReady); update(); }
  function selectSample(index) {
    sample = samples[index]; $('sessionIdInput').value = sample.id; $('detectedAgent').textContent = label(sample.provider); $('detectedCwd').textContent = sample.cwd;
    $('detectedMessages').textContent = sample.messages; $('detectedTools').textContent = sample.tools; $('sourceStatus').textContent = t.loaded;
    $('sourceIcon').src = `/agents/${sample.provider}.svg`; $('sourceIcon').hidden = false;
    if (route() !== 'official') client = 'terminal'; else client = 'desktop';
    reset();
  }
  $('sampleSelect').addEventListener('change', (event) => selectSample(Number(event.target.value)));
  $('sessionIdInput').addEventListener('input', () => {
    const found = samples.findIndex((entry) => entry.id === $('sessionIdInput').value.trim());
    if (found >= 0) { $('sampleSelect').value = found; selectSample(found); return; }
    sample = null; $('detectedAgent').textContent = t.unknown; $('detectedCwd').textContent = '—'; $('detectedMessages').textContent = '—'; $('detectedTools').textContent = '—'; $('sourceStatus').textContent = t.unknown; $('sourceIcon').hidden = true;
    client = 'terminal'; reset();
  });
  document.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => { target = button.dataset.target; client = route() === 'official' ? 'desktop' : 'terminal'; reset(); }));
  document.querySelectorAll('[data-client]').forEach((button) => button.addEventListener('click', () => { client = button.dataset.client; reset(); }));
  $('previewButton').addEventListener('click', () => { if (!sample || state !== 'idle') return; state = 'prepared'; $('planId').textContent = `demo-plan / ${sample.cwd.split('/').at(-1)} / ${target}`; log(t.logPreview); update(); });
  $('confirmButton').addEventListener('click', () => { if (!sample || state !== 'prepared') return; state = 'imported'; log(t.logConfirm); update(); });
  $('openButton').addEventListener('click', () => { if (state !== 'imported') return; state = 'opened'; log(t.logOpen); update(); });
  ['resetDemo', 'restartButton'].forEach((id) => $(id).addEventListener('click', () => selectSample(Number($('sampleSelect').value))));
  $('copyTarget').addEventListener('click', () => copy($('targetCommand').textContent));
  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', () => copy(button.dataset.copy)));
  function resultTab(tab) {
    const logs = tab === 'logs'; $('simLogs').hidden = !logs; $('simAst').hidden = logs; $('logsTab').setAttribute('aria-selected', String(logs)); $('structureTab').setAttribute('aria-selected', String(!logs));
  }
  $('logsTab').addEventListener('click', () => resultTab('logs')); $('structureTab').addEventListener('click', () => resultTab('structure'));
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    document.querySelectorAll('[data-category]').forEach((row) => { row.hidden = button.dataset.filter !== 'all' && row.dataset.category !== button.dataset.filter; });
  }));
  document.querySelectorAll('[data-quick]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-quick]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-selected', String(item === button)); });
    $('cliCommands').hidden = button.dataset.quick !== 'cli'; $('desktopCommands').hidden = button.dataset.quick !== 'desktop';
  }));
  function closeMenu() { document.body.classList.remove('menu-open'); $('menuButton').setAttribute('aria-expanded', 'false'); }
  $('menuButton').addEventListener('click', () => { const open = document.body.classList.toggle('menu-open'); $('menuButton').setAttribute('aria-expanded', String(open)); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  const navLinks = [...document.querySelectorAll('.nav-item')];
  navLinks.forEach((item) => item.addEventListener('click', closeMenu));
  let scheduled = false;
  function updateNavigation() {
    scheduled = false;
    const sections = [...document.querySelectorAll('.site-section')];
    const current = sections.filter((section) => section.getBoundingClientRect().top <= 140).at(-1) || sections[0];
    navLinks.forEach((item) => { const active = item.hash === `#${current.id}`; item.classList.toggle('active', active); if (active) { item.setAttribute('aria-current', 'location'); $('currentSection').textContent = item.querySelector('span').textContent; } else item.removeAttribute('aria-current'); });
  }
  window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(updateNavigation); } }, { passive: true });
  // Tabs and radio choices use their established arrow-key interaction patterns.
  document.querySelectorAll('[role="tablist"], [role="radiogroup"]').forEach((group) => group.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...group.querySelectorAll('button')]; const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].focus(); buttons[next].click();
  }));
  update(); updateNavigation();
})();
