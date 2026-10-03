import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
// Reuse the repository's pinned server bundler; ship no credentials or data.
const require = createRequire(path.join(root, 'apps/server-pkg/package.json'));
const { build } = require('esbuild');
const out = path.join(root, '.data/receiver-release');
fs.mkdirSync(out, { recursive: true });
await build({ entryPoints: [path.join(root, 'apps/demo-seller/receiver-start.mjs')],
  outfile: path.join(out, 'receiver.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
const copies = { 'receiver.Dockerfile': 'Dockerfile', 'moneyswitch.caddy': 'moneyswitch.caddy',
  'activate-caddy.sh': 'activate-caddy.sh', 'run-receiver.sh': 'run-receiver.sh' };
for (const [source, target] of Object.entries(copies)) {
  fs.writeFileSync(path.join(out, target), fs.readFileSync(path.join(root, 'deploy', source), 'utf8').replace(/\r\n/g, '\n'));
}
const files = ['receiver.cjs', ...Object.values(copies)];
fs.writeFileSync(path.join(out, 'SHA256SUMS'), files.map(name =>
  `${createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex')}  ${name}\n`).join(''));
console.log('Receiver bundle built in .data/receiver-release');
