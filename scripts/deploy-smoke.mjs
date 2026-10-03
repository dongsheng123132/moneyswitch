// Acceptance of the built server bundle in a disposable directory. Never uses an existing wallet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
  const setup = output.match(/\/login#(ms_setup_[A-Za-z0-9]+)/)?.[1];
  check('first start offers a one-time sign-in link', !!setup);
  const claim = await api('/v1/setup/claim', 'POST', { setup_token: setup }, '');
  admin = claim.body.admin_token;
  check('claim grants admin exactly once', claim.status === 200 && (await api('/v1/setup/claim', 'POST', { setup_token: setup }, '')).status !== 200);
  const html = await (await fetch(`${base}/`)).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  check('built Dashboard and its hashed JS are served', !!asset && (await fetch(`${base}${asset}`)).ok);
  const approvalPage = await fetch(`${base}/approvals?id=00000000-0000-4000-8000-000000000000`);
  check('an approval link opens the Dashboard', approvalPage.status === 200 && (await approvalPage.text()).includes(asset));
  check('admin metadata requires authentication', (await api('/v1/admin/meta', 'GET', undefined, '')).status === 403);
  const meta = await api('/v1/admin/meta');
  check('both configured testnets are reported', meta.body.networks?.length === 2 && meta.body.networks.every((n) => !n.is_mainnet));

  // wallet: created by the server, unlocks itself, the words are shown once
  check('a fresh data directory has no wallet', (await api('/v1/admin/wallet')).body.has_keystore === false);
  const created = await api('/v1/admin/wallet/create', 'POST', {});
  const phrase = created.body.recovery_phrase;
  check('disposable wallet is created with twelve recovery words', created.status === 200 && /^0x[0-9a-fA-F]{40}$/.test(created.body.address) && typeof phrase === 'string' && phrase.trim().split(/\s+/).length === 12);
  const wallet = await api('/v1/admin/wallet');
  check('the new wallet is unlocked and its words are never shown again', wallet.body.unlocked === true && wallet.body.address === created.body.address && !JSON.stringify(wallet.body).includes(phrase));
  const files = await fs.readdir(dataDir);
  check('the unlock file is named after the wallet address', files.some((f) => /^wallet-unlock-0x[0-9a-fA-F]{40}\.secret$/.test(f) && f.toLowerCase() === `wallet-unlock-${created.body.address.toLowerCase()}.secret`));
  check('the unlock file is readable by this user only', wallet.body.health.secret_protected === true);
  check('writing the words down is recorded', (await api('/v1/admin/wallet/backup/confirm', 'POST', {})).body.confirmed === true);

  const created2 = await api('/v1/keys', 'POST', { name: 'acceptance-only', total_budget: '0.10', daily_budget: '0.05', per_request_limit: '0.01', allowed_hosts: ['app.moneyswitch.dev:443'] });
  check('limited MoneyKey works', created2.status === 200 && (await api('/v1/status', 'GET', undefined, created2.body.key)).status === 200);
  const rotated = await api(`/v1/keys/${created2.body.id}/rotate`, 'POST', {});
  check('rotation immediately invalidates the old key', rotated.status === 200 && (await api('/v1/status', 'GET', undefined, created2.body.key)).status === 401);
  const status = await api('/v1/status', 'GET', undefined, rotated.body.key);
  check('new key retains the original budget', status.status === 200 && Number(status.body.remaining_total) === 0.10);
  const skill = await (await fetch(`${base}/skill.md`)).text();
  check('public skill contains no secret and explains the approval link', skill.includes('/v1/fetch') && skill.includes('approve_url') && !skill.includes(admin) && !skill.includes(rotated.body.key));
  const gone = await Promise.all([
    ['GET', '/v1/admin/tollbooths'], ['GET', '/v1/admin/channels'], ['GET', '/v1/admin/notify'], ['GET', '/v1/admin/wallet/retired'],
    ['POST', '/v1/admin/wallet/unlock'], ['POST', '/v1/admin/wallet/import'], ['POST', '/v1/admin/wallet/reveal'],
    ['POST', '/v1/admin/wallet/backup'], ['POST', '/v1/admin/wallet/auto-unlock'], ['POST', '/v1/admin/local-link'], ['POST', '/v1/local/claim'],
  ].map(([method, route]) => api(route, method, method === 'POST' ? {} : undefined)));
  check('removed routes are absent (seller, push, wallet import / reveal / download / password unlock, launcher)', gone.every((r) => r.status === 404));
  check('removed OpenAI gateway, models and channel routes are absent', (await Promise.all([
    api('/v1/chat/completions', 'POST', { model: 'm', messages: [] }, rotated.body.key),
    api('/v1/models', 'GET', undefined, rotated.body.key),
  ])).every((r) => r.status === 404));

  await stop();
  await start();
  check('admin and rotated key survive a restart', (await api('/v1/keys')).body.keys.some((key) => key.id === created2.body.id) && (await api('/v1/status', 'GET', undefined, rotated.body.key)).status === 200);
  const after = await api('/v1/admin/wallet');
  check('the wallet unlocks itself after a restart: same address, no password given', after.body.unlocked === true && after.body.address === created.body.address && after.body.health.unlock_mode === 'auto' && after.body.health.auto_unlock_ok === true);
  check('the restart printed no new sign-in link and no admin token', !output.includes('Admin token (save this now') && !/\/login#ms_setup_/.test(output));
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
