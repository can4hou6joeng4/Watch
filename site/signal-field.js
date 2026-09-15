(() => {
  'use strict';
  const canvas = document.getElementById('signalCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 1;
  let height = 1;
  let frame = 0;
  let visible = true;
  let pointer = 0;
  let drift = 0;
  let time = 0;
  let last = 0;

  // Adapt Signal Ledger's public curve geometry without its preview wrappers or remote runtime.
  function curve(t, kind) {
    if (kind === 'vertical') return [width * (.835 - .265 * Math.sin(t * Math.PI * .92) + .078 * Math.sin(t * Math.PI * 2.18 + .66) + Math.sin(t * Math.PI * 2 + time * .28) * .012) + drift, height * (-.18 + 1.36 * t)];
    if (kind === 'lower') return [width * (.27 + .84 * t) + drift, height * (.825 - .305 * Math.sin(Math.PI * t) + .052 * Math.sin(Math.PI * 2 * t + 1.2 + time * .18))];
    const a = t * Math.PI * 2;
    const x = Math.cos(a) * width * .205;
    const y = Math.sin(a) * height * .108 + Math.sin(a * 3 + time * .25) * height * .004;
    return [width * .555 + x * Math.cos(-.22) - y * Math.sin(-.22) + drift, height * .565 + x * Math.sin(-.22) + y * Math.cos(-.22)];
  }
  function ribbon(kind, lanes, spacing, alpha) {
    for (let lane = -lanes; lane <= lanes; lane++) {
      ctx.beginPath();
      for (let i = 0; i <= 170; i++) {
        const t = i / 170;
        const p = curve(t, kind);
        const next = curve(t + .001, kind);
        const dx = next[0] - p[0];
        const dy = next[1] - p[1];
        const length = Math.hypot(dx, dy) || 1;
        const x = p[0] - dy / length * lane * spacing;
        const y = p[1] + dx / length * lane * spacing;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = kind === 'vertical' ? 1.6 : .7;
      ctx.strokeStyle = `rgba(218,224,233,${alpha * (.75 + Math.sin(lane * .7 + time * .5) * .2)})`;
      ctx.stroke();
    }
  }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    drift += (pointer - drift) * .025;
    ribbon('lower', 7, 6, .12);
    ribbon('loop', 6, 7, .14);
    ribbon('vertical', 5, Math.max(5, Math.min(10, width * .007)), .74);
    canvas.dataset.rendered = 'true';
  }
  function tick(now) {
    frame = 0;
    if (document.hidden || !visible || reducedMotion.matches) return;
    if (now - last >= 32) { time = now * .001; draw(); last = now; }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    draw();
    if (!document.hidden && visible && !reducedMotion.matches) frame = requestAnimationFrame(tick);
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    sync();
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(canvas);
  canvas.parentElement.addEventListener('pointermove', (event) => { if (!reducedMotion.matches) pointer = (event.clientX / width - .5) * 10; }, { passive: true });
  canvas.parentElement.addEventListener('pointerleave', () => { pointer = 0; }, { passive: true });
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  resize();
})();
