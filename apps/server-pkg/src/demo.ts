import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Wallet as EthersWallet } from "ethers";
import { startServer, type FirstRunSecrets, type RunningServer, type ServerConfig } from "@moneyswitch/server/start";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { createDemoSellerApp } from "@moneyswitch/demo-seller/app";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bundledDashboardDir, bundledMigrationsDir } from "./paths.js";

/**
 * `moneyswitch-server demo` — a fully offline, throwaway MoneySwitch.
 *
 * Everything runs in THIS process: mock x402 facilitator → demo seller (LLM
 * echo mode, no upstream key) → MoneySwitch server + Dashboard, on free
 * loopback ports, with a fresh temp data directory. Real code paths all the
 * way (real EIP-3009 signatures verified by the mock facilitator); only the
 * settlement is simulated (`0xmock…` hashes, never a chain).
 *
 * Sign-in uses the server's own first-run one-time setup link, exactly as
 * printed on any first boot — the demo just opens it for you. No extra
 * authentication path exists.
 */

export interface DemoOptions {
  startPort: number;
  host: string;
  open: boolean;
  version: string;
}

/** Simulated starting balance of the demo wallet (USDC). */
const DEMO_START_BALANCE_MICROS = 20_000_000;
const DEMO_MODEL = "moneyswitch-demo-chat";

function log(msg: string) {
  process.stdout.write(`[demo] ${msg}\n`);
}

/** True when nothing accepts connections on host:port AND we can bind it ourselves. */
async function isPortFree(port: number, host: string): Promise<boolean> {
  const connectable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ port, host: host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(400, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
  if (connectable) return false;
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(from: number, host: string, taken: Set<number>): Promise<number> {
  for (let p = from; p < Math.min(from + 200, 65536); p++) {
    if (taken.has(p)) continue;
    if (await isPortFree(p, host)) {
      taken.add(p);
      return p;
    }
  }
  throw new Error(`no free port found in ${from}–${from + 199}`);
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function openBrowser(url: string) {
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
  const child =
    process.platform === "win32"
      ? // Inside double quotes cmd treats "&" (in the #fragment) literally.
        spawn("cmd", ["/d", "/s", "/c", `start "" "${url}"`], { ...opts, windowsVerbatimArguments: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], opts);
  child.on("error", () => undefined);
  child.unref();
}

async function api<T>(base: string, token: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json as T;
}

interface Seeded {
  claudeKey: string;
  codexKey: string;
  payments: number;
}

/** Pre-loads the demo: channel, two MoneyKeys, a few real (mock-settled) payments. */
async function seed(base: string, adminToken: string, sellerUrl: string): Promise<Seeded> {
  const sellerHost = new URL(sellerUrl).host;
  const serverHost = new URL(base).host;

  await api(base, adminToken, "POST", "/v1/admin/channels", {
    name: "Demo LLM (x402)",
    base_url: `${sellerUrl}/v1`,
    models: [DEMO_MODEL],
  });

  const claude = await api<{ key: string }>(base, adminToken, "POST", "/v1/keys", {
    name: "Claude Code",
    total_budget: "10",
    daily_budget: "5",
    per_request_limit: "1",
    approval_threshold: "0.10",
    allowed_hosts: [sellerHost, serverHost],
  });
  const codex = await api<{ key: string }>(base, adminToken, "POST", "/v1/keys", {
    name: "Codex",
    total_budget: "5",
    daily_budget: "2",
    per_request_limit: "0.50",
    approval_threshold: null,
    allowed_hosts: [sellerHost, serverHost],
  });

  let payments = 0;
  const chat = async (key: string, content: string) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: DEMO_MODEL, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) throw new Error(`demo chat failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    payments++;
  };
  const paidFetch = async (key: string, url: string) => {
    const out = await api<{ status: string; code: string | null }>(base, key, "POST", "/v1/fetch", { url, method: "GET" });
    if (out.status !== "ok") throw new Error(`demo fetch ${url} → ${out.status} ${out.code ?? ""}`);
    payments++;
  };

  await chat(codex.key, "Write a one-line commit message for a typo fix.");
  await chat(claude.key, "Summarize today's stand-up in one sentence.");
  await paidFetch(claude.key, `${sellerUrl}/premium-report`);
  await paidFetch(codex.key, `${sellerUrl}/premium-report`);
  await paidFetch(claude.key, `${sellerUrl}/premium-report`);
  await paidFetch(codex.key, `${sellerUrl}/premium-report`);
  await chat(codex.key, "Explain x402 in ten words.");

  return { claudeKey: claude.key, codexKey: codex.key, payments };
}

function removeDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort (reported below)
  }
}

const DEMO_DIR_PREFIX = "moneyswitch-demo-";
const PID_FILE = "demo.pid";

/** Deletes temp dirs left behind by demos that were killed hard (their owner process is gone). */
function sweepStaleDemoDirs() {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith(DEMO_DIR_PREFIX));
  } catch {
    return;
  }
  for (const e of entries) {
    const dir = path.join(os.tmpdir(), e);
    try {
      const pid = Number(fs.readFileSync(path.join(dir, PID_FILE), "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        continue; // still running
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      removeDir(dir);
    } catch {
      // no pid file (being created, or not ours) — leave it
    }
  }
}

export async function runDemo(opts: DemoOptions): Promise<void> {
  sweepStaleDemoDirs();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), DEMO_DIR_PREFIX));
  fs.writeFileSync(path.join(dataDir, PID_FILE), String(process.pid));
  const cleanups: Array<() => Promise<void> | void> = [];
  let server: RunningServer | null = null;
  let stopping = false;

  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("\n");
    log("stopping demo services…");
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // keep going
      }
    }
    removeDir(dataDir);
    log(fs.existsSync(dataDir) ? `could not fully delete ${dataDir} — remove it by hand` : `deleted temporary data ${dataDir}`);
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGHUP", () => void stop(0));
  // Windows: Ctrl+Break (and what process managers send) arrives as SIGBREAK.
  if (process.platform === "win32") process.on("SIGBREAK", () => void stop(0));

  try {
    log(`MoneySwitch ${opts.version} offline demo — DEMO · simulated settlement, no real money moves`);
    const taken = new Set<number>();
    const serverPort = await findFreePort(opts.startPort, opts.host, taken);
    const sellerPort = await findFreePort(serverPort + 1, "127.0.0.1", taken);
    const facilitatorPort = await findFreePort(sellerPort + 1, "127.0.0.1", taken);

    // 1. mock x402 facilitator (verifies real EIP-3009 signatures, settles nothing)
    const facilitator = buildMockFacilitator();
    await facilitator.listen({ port: facilitatorPort, host: "127.0.0.1" });
    cleanups.push(() => facilitator.close());
    const facilitatorUrl = `http://127.0.0.1:${facilitatorPort}`;

    // 2. demo seller (echo LLM + paid reports + the free /weather upstream)
    const sellerPayTo = EthersWallet.createRandom().address;
    const sellerHttp = http.createServer(createDemoSellerApp({ payTo: sellerPayTo, facilitatorUrl }));
    await listen(sellerHttp, sellerPort, "127.0.0.1");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          sellerHttp.closeAllConnections?.();
          sellerHttp.close(() => resolve());
        })
    );
    const sellerUrl = `http://127.0.0.1:${sellerPort}`;

    // 3. mock wallet: a brand-new random key in the temp dir, holding nothing
    //    real. Balance shown in the Dashboard is simulated (config.demo).
    const walletPassword = randomBytes(18).toString("base64url");
    await new LocalWalletDriver(dataDir).createWallet(walletPassword);

    // 4. the MoneySwitch server itself
    let secrets: FirstRunSecrets | null = null;
    const config: ServerConfig = {
      port: serverPort,
      host: opts.host,
      dataDir,
      dbFilePath: path.join(dataDir, "moneyswitch.sqlite"),
      walletPassword,
      demoSellerUrl: sellerUrl,
      cliTarballPath: path.join(dataDir, "moneyswitch-cli-not-bundled.tgz"),
      maxKeyDepth: 3,
      facilitatorUrl,
      publicUrl: null,
      reconcileIntervalMs: 0,
      dashboardDir: bundledDashboardDir(),
      migrationsDir: bundledMigrationsDir(),
      demo: { startingBalanceMicros: DEMO_START_BALANCE_MICROS },
    };
    const prevLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = process.env.MONEYSWITCH_DEMO_LOG_LEVEL || "warn";
    server = await startServer(config, { onFirstRun: (s) => (secrets = s) });
    if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLogLevel;
    const running = server;
    cleanups.push(() => running.close());
    const s = secrets as FirstRunSecrets | null;
    if (!s) throw new Error("fresh demo data dir did not produce a first-run setup link");

    // 5. pre-load channel, keys, a few payments
    const base = `http://${opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host}:${serverPort}`;
    const seeded = await seed(base, s.adminToken, sellerUrl);

    const link = `${s.setupUrl}&demo_key=${seeded.claudeKey}`;
    const line = "─".repeat(72);
    process.stdout.write(
      [
        "",
        line,
        "  MoneySwitch DEMO — simulated settlement, no real money moves",
        line,
        `  Dashboard (opens signed in, one-time link):`,
        `    ${link}`,
        "",
        `  Pre-loaded: mock wallet (20 USDC simulated) · channel "Demo LLM (x402)"`,
        `              MoneyKeys "Claude Code" + "Codex"`,
        `              ${seeded.payments} demo payments (settled by the mock facilitator)`,
        "",
        "  Try: Playground → send a message ($0.01) · buy the $5 report (blocked) ·",
        "",
        `  Demo admin token (to sign in from another browser): ${s.adminToken}`,
        `  Services: server ${base} · demo seller ${sellerUrl} · mock facilitator ${facilitatorUrl}`,
        `  Data: ${dataDir} (deleted on exit)`,
        "",
        "  Press Ctrl+C to stop everything and delete the demo data.",
        line,
        "",
      ].join("\n")
    );
    if (opts.open) openBrowser(link);
  } catch (err) {
    process.stderr.write(`[demo] failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    await stop(1);
  }
}
