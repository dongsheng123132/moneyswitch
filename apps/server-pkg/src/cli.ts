import os from "node:os";
import path from "node:path";
import { installOutboundProxy, redactProxyUrl } from "@moneyswitch/net";
import { loadConfig, startServer } from "@moneyswitch/server/start";
import { parseArgs, DEFAULT_HOST, DEFAULT_PORT } from "./args.js";
import { bundledDashboardDir, bundledMigrationsDir } from "./paths.js";
import { runDemo } from "./demo.js";

// Earliest possible point: before parseArgs()/serve()/runDemo() make any
// outbound call themselves (facilitator, viem RPC, toll booth forwarding,
// paid_fetch all go through the global fetch dispatcher this installs) —
// mirrors apps/server/src/index.ts, which this npx-installed package does
// not import (it consumes @moneyswitch/server/start directly, not its
// entrypoint), so the proxy install here is this package's own copy of the
// same "earliest point" wiring, not a duplicate of an already-installed one.
const outboundProxy = installOutboundProxy();
console.log(
  outboundProxy.url
    ? `[moneyswitch] outbound proxy: ${redactProxyUrl(outboundProxy.url)} (source: ${outboundProxy.source})`
    : "[moneyswitch] outbound proxy: none (direct)"
);

declare const __MONEYSWITCH_SERVER_VERSION__: string | undefined;
export const VERSION = typeof __MONEYSWITCH_SERVER_VERSION__ === "string" ? __MONEYSWITCH_SERVER_VERSION__ : "0.0.0-dev";

export const HELP = `moneyswitch-server ${VERSION} — self-hosted MoneySwitch server + Dashboard (AGPL-3.0-only)

Usage:
  npx moneyswitch-server [--data-dir <dir>] [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}]
  npx moneyswitch-server demo [--port ${DEFAULT_PORT}] [--no-open]

Self-hosted server (default command):
  --data-dir <dir>   where the database + encrypted wallet keystore live
                     (default: ~/.moneyswitch/server, or $MONEYSWITCH_DATA_DIR)
  --port <n>         HTTP port (default: ${DEFAULT_PORT}, or $MONEYSWITCH_PORT)
  --host <addr>      bind address (default: ${DEFAULT_HOST}, or $MONEYSWITCH_HOST;
                     use 0.0.0.0 only behind HTTPS / a reverse proxy)
  On the first start of a data directory it prints the admin token and a
  one-time setup link (valid 30 min, single use) — open it to finish setup.
  Other settings keep their MONEYSWITCH_* environment variables
  (MONEYSWITCH_WALLET_PASSWORD(_FILE), MONEYSWITCH_PUBLIC_URL, …).

demo — fully offline 30-second tour, no real money:
  Starts a mock x402 facilitator, a demo seller (LLM echo mode) and a
  server on free ports (from --port, default ${DEFAULT_PORT}) with a throwaway
  data directory, pre-loads a mock wallet, a demo channel, two MoneyKeys
  ("Claude Code", "Codex") and a few payments, then opens the
  Dashboard already signed in. Settlement is simulated (0xmock… hashes);
  nothing touches a real chain. Ctrl+C stops everything and deletes the data.
  --no-open          print the link instead of opening a browser

  -h, --help         show this help
  -v, --version      print the version

Docs: https://github.com/dongsheng123132/moneyswitch#readme`;

async function serve(dataDirFlag: string | null, portFlag: number | null, hostFlag: string | null): Promise<void> {
  const base = loadConfig();
  const dataDir = path.resolve(dataDirFlag ?? process.env.MONEYSWITCH_DATA_DIR ?? path.join(os.homedir(), ".moneyswitch", "server"));
  const config = {
    ...base,
    port: portFlag ?? base.port,
    host: hostFlag ?? base.host,
    dataDir,
    dbFilePath: process.env.MONEYSWITCH_DB_PATH || path.join(dataDir, "moneyswitch.sqlite"),
    dashboardDir: bundledDashboardDir(),
    migrationsDir: bundledMigrationsDir(),
    // The Apache-2.0 client CLI is its own npm package (`npx moneyswitch`);
    // this AGPL package does not ship its tarball.
    cliTarballPath: path.join(dataDir, "moneyswitch-cli-not-bundled.tgz"),
  };
  console.log(`[moneyswitch] moneyswitch-server ${VERSION} — data dir: ${dataDir}`);
  let running;
  try {
    running = await startServer(config);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.error(`[moneyswitch] port ${config.port} on ${config.host} is already in use — pick another with --port <n>`);
    } else {
      console.error("[moneyswitch] fatal startup error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
  console.log(`[moneyswitch] server + Dashboard listening on ${running.url}  (Ctrl+C to stop)`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await running.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.platform === "win32") process.on("SIGBREAK", stop);
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    process.stderr.write(`moneyswitch-server needs Node.js 22 or newer (this is ${process.version}); its SQLite driver (better-sqlite3 13) does not load on older versions.
`);
    process.exit(1);
  }
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.kind) {
    case "help":
      process.stdout.write(HELP + "\n");
      return;
    case "version":
      process.stdout.write(VERSION + "\n");
      return;
    case "error":
      process.stderr.write(`moneyswitch-server: ${parsed.message}\n\nRun "moneyswitch-server --help" for usage.\n`);
      process.exit(2);
      return;
    case "demo":
      await runDemo({ startPort: parsed.port, host: parsed.host, open: parsed.open, version: VERSION });
      return;
    case "serve":
      await serve(parsed.dataDir, parsed.port, parsed.host);
      return;
  }
}

main().catch((err) => {
  process.stderr.write(`moneyswitch-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
