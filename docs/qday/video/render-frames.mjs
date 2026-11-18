import { chromium } from '/Users/dosen8618607105700/.nvm/versions/node/v24.13.1/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const FPS = 30;
const DURATION = 56;
const OUT = process.argv[2] || 'frames';
const ONLY = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('file://' + process.cwd() + '/index.html', { waitUntil: 'load' });
await page.evaluate(async () => {
  await document.fonts.ready;
  const imgs = Array.from(document.images);
  await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  document.querySelectorAll('audio').forEach((a) => { a.pause(); a.muted = true; });
});
await page.waitForTimeout(800);

const total = Math.round(FPS * DURATION);
const times = ONLY ? ONLY : Array.from({ length: total }, (_, i) => i / FPS);
for (const t of times) {
  await page.evaluate((time) => {
    const tl = window.__timelines['main'];
    tl.pause();
    tl.seek(time, false);
    // The CLI runtime owns clip visibility; here we are the runtime.
    document.querySelectorAll('.clip').forEach((el) => {
      const start = parseFloat(el.dataset.start || '0');
      const dur = parseFloat(el.dataset.duration || '0');
      const on = time >= start && time < start + dur;
      el.style.visibility = on ? 'visible' : 'hidden';
    });
  }, t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const name = `${OUT}/f${String(Math.round(t * FPS)).padStart(5, '0')}.png`;
  await page.screenshot({ path: name, type: 'png' });
  if (times.indexOf(t) % 120 === 0) console.log('rendered', t.toFixed(2), 's');
}
await browser.close();
console.log('done', times.length, 'frames');
