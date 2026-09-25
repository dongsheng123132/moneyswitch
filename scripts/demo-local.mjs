#!/usr/bin/env node
/**
 * One-command local demo stack: mock-facilitator -> demo-seller -> server.
 * No real facilitator, no real payment, ever. Data lives under repo-local
 * `.data/local/` (gitignored) so it never touches `~/.moneyswitch`.
 *
 * Usage: `pnpm demo:local` (or `node scripts/demo-local.mjs`)
 * Stop with Ctrl+C — all three child processes are killed together.
 */
import path from "node:path";
import fs from "node:fs";
import { Wallet as EthersWallet } from "ethers";
import { REPO_ROOT, waitForHttp, spawnLogged, installShutdownHandlers } from "./lib/demo-common.mjs";

const DATA_DIR = path.join(REPO_ROOT, ".data", "local");
const MOCK_FACILITATOR_PORT = 4099;
const SELLER_PORT = 4021;
const SERVER_PORT = 4020;

const walletPassword = process.env.MONEYSWITCH_WALLET_PASSWORD;
if (!walletPassword) {
  console.warn(
    "[demo:local] MONEYSWITCH_WALLET_PASSWORD not set — using default 'demo-password'. " +
      "仅限本地演示，不要在生产或任何有真实资金的环境里用这个默认密码。"
  );
}
const effectiveWalletPassword = walletPassword || "demo-password";

const payTo = process.env.DEMO_SELLER_PAY_TO || EthersWallet.createRandom().address;
if (!process.env.DEMO_SELLER_PAY_TO) {
  console.log(`[demo:local] DEMO_SELLER_PAY_TO not set — generated a random demo address: ${payTo}`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

async function main() {
  console.log("[demo:local] starting mock-facilitator...");
  const mockFacilitator = spawnLogged(
    "mock-facilitator",
    process.execPath,
    [path.join(REPO_ROOT, "packages", "mock-facilitator", "dist", "server.js")],
    { env: { ...process.env, MOCK_FACILITATOR_PORT: String(MOCK_FACILITATOR_PORT) }, cwd: REPO_ROOT },
    path.join(DATA_DIR, "mock-facilitator.log")
  );
  await waitForHttp(`http://127.0.0.1:${MOCK_FACILITATOR_PORT}/supported`);
  console.log(`[demo:local] mock-facilitator up on :${MOCK_FACILITATOR_PORT} (log: .data/local/mock-facilitator.log)`);

  console.log("[demo:local] starting demo-seller...");
  const demoSeller = spawnLogged(
    "demo-seller",
    process.execPath,
    [path.join(REPO_ROOT, "apps", "demo-seller", "dist", "index.js")],
    {
      env: {
        ...process.env,
        DEMO_SELLER_PORT: String(SELLER_PORT),
        DEMO_SELLER_PAY_TO: payTo,
        DEMO_SELLER_FACILITATOR_URL: `http://127.0.0.1:${MOCK_FACILITATOR_PORT}`,
      },
      cwd: REPO_ROOT,
    },
    path.join(DATA_DIR, "demo-seller.log")
  );
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`);
  console.log(`[demo:local] demo-seller up on :${SELLER_PORT} (log: .data/local/demo-seller.log)`);

  console.log("[demo:local] starting server...");
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
        MONEYSWITCH_WALLET_PASSWORD: effectiveWalletPassword,
      },
      cwd: REPO_ROOT,
    },
    serverLogPath
  );
  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`);
  console.log(`[demo:local] server up on :${SERVER_PORT}`);

  console.log("\n[demo:local] all services running:");
  console.log(`  mock-facilitator: http://127.0.0.1:${MOCK_FACILITATOR_PORT}`);
  console.log(`  demo-seller:      http://127.0.0.1:${SELLER_PORT}  (payTo=${payTo})`);
  console.log(`  server + Dashboard: http://127.0.0.1:${SERVER_PORT}`);
  console.log(
    `\n[demo:local] admin token (ms_admin_xxx) was printed exactly once — see ${path.relative(
      REPO_ROOT,
      serverLogPath
    )} (only on first boot of a fresh data dir; not re-printed on restart).`
  );
  console.log("[demo:local] press Ctrl+C to stop all three services.\n");

  installShutdownHandlers([mockFacilitator, demoSeller, server]);
}

main().catch((err) => {
  console.error("[demo:local] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
