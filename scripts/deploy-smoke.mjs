// Acceptance of the built server bundle in a disposable directory. Never uses an existing wallet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MONEYSWITCH_SMOKE_ENTRY || path.join(repo, 'apps/server-pkg/dist/cli.js');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moneyswitch-acceptance-'));
const holder = net.createServer();
await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
const port = holder.address().port;
await new Promise((resolve) => holder.close(resolve));
const base = `http://127.0.0.1:${port}`;
let proc, output = '', admin = '', passed = 0;
const check = (name, ok) => { assert.ok(ok, name); passed++; console.log(`PASS ${name}`); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  output = '';
  proc = spawn(process.execPath, [entry, '--data-dir', dataDir, '--port', String(port)], {
    env: { ...process.env, MONEYSWITCH_NETWORKS: 'eip155:10143,eip155:84532', MONEYSWITCH_DEFAULT_NETWORK: 'eip155:10143',
      MONEYSWITCH_PUBLIC_URL: base, MONEYSWITCH_TESTNET_RPC_URL: 'http://127.0.0.1:1',
      MONEYSWITCH_WALLET_PASSWORD: '', MONEYSWITCH_WALLET_PASSWORD_FILE: '',
      MONEYSWITCH_RECONCILE_INTERVAL_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  proc.on('error', (error) => { output += error.message; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    if (proc.exitCode !== null) break;
    await pause(100);
  }
  throw new Error('built server failed to become healthy');
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const stopped = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  await Promise.race([stopped, pause(5000)]);
  if (proc.exitCode === null) { proc.kill('SIGKILL'); await stopped; }
}
async function api(route, method = 'GET', body, token = admin) {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
try {
  await start();
  check('native SQLite bundle starts and health is OK', true);
  const setup = output.match(/\/setup#(ms_setup_[A-Za-z0-9]+)/)?.[1];
  check('first start offers a one-time setup link', !!setup);
  const claim = await api('/v1/setup/claim', 'POST', { setup_token: setup }, '');
  admin = claim.body.admin_token;
  check('claim grants admin exactly once', claim.status === 200 && (await api('/v1/setup/claim', 'POST', { setup_token: setup }, '')).status !== 200);
  const html = await (await fetch(`${base}/`)).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  check('built Dashboard and its hashed JS are served', !!asset && (await fetch(`${base}${asset}`)).ok);
  check('admin metadata requires authentication', (await api('/v1/admin/meta', 'GET', undefined, '')).status === 403);
  const meta = await api('/v1/admin/meta');
  check('both configured testnets are reported', meta.body.networks?.length === 2 && meta.body.networks.every((n) => !n.is_mainnet));
  const password = randomBytes(24).toString('hex');
  check('disposable encrypted wallet can be created', (await api('/v1/admin/wallet/create', 'POST', { password })).status === 200);
  check('disposable wallet unlocks', (await api('/v1/admin/wallet/unlock', 'POST', { password })).body.unlocked === true);
  const created = await api('/v1/keys', 'POST', { name: 'acceptance-only', total_budget: '0.10', daily_budget: '0.05', per_request_limit: '0.01', allowed_hosts: [] });
  check('limited MoneyKey works', created.status === 200 && (await api('/v1/status', 'GET', undefined, created.body.key)).status === 200);
  const rotated = await api(`/v1/keys/${created.body.id}/rotate`, 'POST', {});
  check('rotation immediately invalidates the old key', rotated.status === 200 && (await api('/v1/status', 'GET', undefined, created.body.key)).status === 401);
  const status = await api('/v1/status', 'GET', undefined, rotated.body.key);
  check('new key retains the original budget', status.status === 200 && Number(status.body.remaining_total) === 0.10);
  const skill = await (await fetch(`${base}/skill.md`)).text();
  check('public skill contains no secret', skill.includes('/v1/fetch') && !skill.includes(admin) && !skill.includes(rotated.body.key));
  check('retired seller route is absent', (await api('/v1/admin/tollbooths')).status === 404);
  check('removed OpenAI gateway, models and channel routes are absent', (await Promise.all([
    api('/v1/chat/completions', 'POST', { model: 'm', messages: [] }, rotated.body.key),
    api('/v1/models', 'GET', undefined, rotated.body.key),
    api('/v1/admin/channels'),
  ])).every((r) => r.status === 404));
  await stop();
  await start();
  check('admin and rotated key survive a restart', (await api('/v1/keys')).body.keys.some((key) => key.id === created.body.id) && (await api('/v1/status', 'GET', undefined, rotated.body.key)).status === 200);
  const walletState = await api('/v1/admin/wallet');
  check('encrypted wallet survives and is locked after restart', walletState.body.unlocked === false && (await api('/v1/admin/wallet/unlock', 'POST', { password })).body.unlocked === true && !output.includes('Admin token (save this now'));
  console.log(JSON.stringify({ passed, failed: 0, real_payments: 0, data: 'disposable' }));
} catch (error) {
  console.error(String(error.message).replace(/(?:ms_admin_|ms_setup_|mk_live_)[A-Za-z0-9]+/g, '[redacted]'));
  process.exitCode = 1;
} finally {
  await stop();
  if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('moneyswitch-acceptance-')) {
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
