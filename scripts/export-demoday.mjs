// The website source is authoritative; the local handout is an exact copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'apps/dashboard/public/demoday.html');
const output = path.join(root, '.data/demoday/MoneySwitch-DemoDay-5min.html');
const html = await fs.readFile(source);
assert.ok(html.toString().includes('data-moneyswitch-demoday="2026-10-11"'), 'Missing presentation marker');
assert.ok(html.toString().includes('id="demo-qr-slot"'), 'Missing public presentation QR');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await fs.readFile(output)), digest(html));
const manifest = { source: 'apps/dashboard/public/demoday.html', sha256: digest(html),
  local_html: output, page_url: 'https://app.moneyswitch.dev/demoday.html', duration_minutes: 5,
  byte_identical: true };
await fs.writeFile(path.join(path.dirname(output), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
