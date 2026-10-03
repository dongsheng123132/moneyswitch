#!/usr/bin/env node
/**
 * Local test stack (test seller + server) wired to the REAL Monad testnet facilitator
 * (https://x402-facilitator.molandak.org). No mock-facilitator is started.
 *
 * This script does NOT auto-fund anything and does NOT send any payment by
 * itself — it only starts demo-seller + server so a human/agent can drive a
 * real testnet payment manually (see docs/quickstart.md). The operator has to
 * create the wallet in the Dashboard and fund it with testnet USDC before any
 * real payment will succeed.
 *
 * Usage: `pnpm demo:testnet` (or `node scripts/demo-testnet.mjs`)
 * Requires: DEMO_SELLER_PAY_TO env var (no default — must not accidentally
 * reuse a throwaway/random address for a route that will receive real USDC).
 * Stop with Ctrl+C.
 */
import path from "node:path";
import fs from "node:fs";
import { REPO_ROOT, waitForHttp, spawnLogged, installShutdownHandlers } from "./lib/demo-common.mjs";

const SELLER_PORT = 4021;
const SERVER_PORT = 4020;
const REAL_FACILITATOR_URL = "https://x402-facilitator.molandak.org";
const DATA_DIR = path.join(REPO_ROOT, ".data", "testnet");

const payTo = process.env.DEMO_SELLER_PAY_TO;
if (!payTo) {
  console.error(
    "[demo:testnet] DEMO_SELLER_PAY_TO is required (must be a real address you control on Monad testnet) " +
      "— refusing to default it, since this path can move real testnet USDC. Example:\n" +
      "  DEMO_SELLER_PAY_TO=0xYourAddress pnpm demo:testnet"
  );
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

async function main() {
  console.log(`[demo:testnet] starting demo-seller against REAL facilitator ${REAL_FACILITATOR_URL} ...`);
  const demoSeller = spawnLogged(
    "demo-seller",
    process.execPath,
    [path.join(REPO_ROOT, "apps", "demo-seller", "dist", "index.js")],
    {
      env: {
        ...process.env,
        DEMO_SELLER_PORT: String(SELLER_PORT),
        DEMO_SELLER_PAY_TO: payTo,
        DEMO_SELLER_FACILITATOR_URL: REAL_FACILITATOR_URL,
      },
      cwd: REPO_ROOT,
    },
    path.join(DATA_DIR, "demo-seller.log")
  );
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`);
  console.log(`[demo:testnet] demo-seller up on :${SELLER_PORT} (log: .data/testnet/demo-seller.log)`);

  console.log("[demo:testnet] starting server...");
  const serverLogPath = path.join(DATA_DIR, "server.log");
  const server = spawnLogged(
    "server",
    process.execPath,
    [path.join(REPO_ROOT, "apps", "server", "dist", "index.js")],
    {
      env: {
        ...process.env,
        MONEYSWITCH_PORT: String(SERVER_PORT),
        MONEYSWITCH_DATA_DIR: DATA_DIR,
      },
      cwd: REPO_ROOT,
    },
    serverLogPath
  );
  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`);
  console.log(`[demo:testnet] server up on :${SERVER_PORT}`);

  console.log("\n[demo:testnet] all services running (REAL Monad testnet facilitator, no mock):");
  console.log(`  demo-seller:        http://127.0.0.1:${SELLER_PORT}  (payTo=${payTo})`);
  console.log(`  server + Dashboard: http://127.0.0.1:${SERVER_PORT}`);
  console.log(
    `\n[demo:testnet] admin token was printed exactly once — see ${path.relative(
      REPO_ROOT,
      serverLogPath
    )} (only on first boot of a fresh data dir). Fund the wallet (see docs/quickstart.md) before attempting a real payment: sign in, create the wallet on the Wallet page, then send testnet USDC to its address.`
  );
  console.log("[demo:testnet] press Ctrl+C to stop both services.\n");

  // First boot of a fresh data dir: surface the one-time sign-in link (NOT the
  // admin token) in this terminal. It is single-use and expires in 30 min, so
  // echoing it here is far less sensitive than the admin token itself.
  const setupLink = findSetupLink(serverLogPath);
  if (setupLink) {
    console.log(`[demo:testnet] 首次启动 / first run — open this one-time sign-in link:

    ${setupLink}
`);
  }

  installShutdownHandlers([demoSeller, server]);
}

/** Returns the sign-in link printed by the most recent server start in this log, if any. */
function findSetupLink(logPath) {
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const lastRun = text.slice(text.lastIndexOf("===== "));
    const m = /(http:\/\/\S+\/login#ms_setup_[A-Za-z0-9]+)/.exec(lastRun);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error("[demo:testnet] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
