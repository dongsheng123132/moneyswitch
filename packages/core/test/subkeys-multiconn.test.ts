import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openDb } from "@moneyswitch/db";
import { createMoneyKey } from "../src/keys.js";
import { createChildKey } from "../src/delegation.js";
import { parseUsdcToMicros as usdc } from "../src/money.js";
import { usedToday } from "../src/ledger.js";

/**
 * v0.4 concurrency, the hard way: every payer runs in its OWN worker thread
 * with its OWN SQLite connection to the same database file, all released at
 * the same instant. Unlike the in-process test (where Node's single thread
 * serializes synchronous calls anyway), here the only thing preventing
 * over-spend is BEGIN IMMEDIATE in evaluateAndReserveInTransaction.
 *
 * Workers load the compiled packages/core + packages/db dist (plain JS); the
 * test refuses to run against a dist older than the policy sources.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(here, "..", "dist", "index.js");
const dbDist = path.resolve(here, "..", "..", "db", "dist", "index.js");

function assertDistFresh() {
  const srcs = ["policy.ts", "chain.ts", "ledger.ts", "delegation.ts", "keys.ts"].map((f) =>
    path.resolve(here, "..", "src", f)
  );
  if (!fs.existsSync(coreDist)) throw new Error(`packages/core/dist missing — run pnpm build first`);
  const distTime = fs.statSync(coreDist).mtimeMs;
  const distPolicy = path.resolve(here, "..", "dist", "policy.js");
  const newestSrc = Math.max(...srcs.map((s) => fs.statSync(s).mtimeMs));
  const oldestDist = Math.min(distTime, fs.statSync(distPolicy).mtimeMs);
  if (oldestDist < newestSrc) {
    throw new Error("packages/core/dist is older than src — run `pnpm --filter @moneyswitch/core build` first");
  }
}

const WORKER_SRC = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const core = await import(workerData.coreUrl);
  const dbm = await import(workerData.dbUrl);
  const { db, sqlite } = dbm.openDb({ filePath: workerData.file });
  sqlite.pragma("busy_timeout = 10000");
  const key = core.getMoneyKeyById(db, workerData.keyId);
  const flag = new Int32Array(workerData.gate);
  Atomics.wait(flag, 0, 0); // all workers released together
  const results = [];
  for (let i = 0; i < workerData.count; i++) {
    try {
      core.evaluateAndReserveInTransaction(sqlite, db, key, {
        url: "https://example.com/deep-report", host: "example.com:443", method: "GET", body: undefined,
        network: "eip155:10143", asset: "0xasset", payTo: "0xpay", amount: BigInt(workerData.amount),
      });
      results.push("ok");
    } catch (e) {
      results.push(e && e.code ? e.code : String(e && e.message));
    }
  }
  sqlite.close();
  parentPort.postMessage(results);
})().catch((e) => parentPort.postMessage(["WORKER_ERROR:" + (e && e.stack)]));
`;

describe("v0.4 concurrency across SQLite connections (worker threads)", () => {
  it("parent daily=1.00, two children daily=1.00, 5 workers per child x 1 payment of 0.15 -> exactly 6 tree-wide", async () => {
    assertDistFresh();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-subkeys-mc-"));
    const file = path.join(dir, "t.sqlite");
    const { db, sqlite } = openDb({ filePath: file });
    try {
      const { row: r } = createMoneyKey(db, {
        name: "root",
        totalBudget: usdc("100"),
        dailyBudget: usdc("1.00"),
        perRequestLimit: usdc("1"),
        allowedHosts: ["example.com:443"],
        maxPaymentsPerMinute: 1000,
        canDelegate: true,
      });
      const mk = () =>
        createChildKey(
          db,
          r.id,
          { name: "c", dailyBudget: usdc("1.00"), totalBudget: usdc("100"), perRequestLimit: usdc("1") },
          { maxDepth: 3 }
        ).row;
      const a = mk();
      const b = mk();

      const gate = new SharedArrayBuffer(4);
      const workers = [a, b].flatMap((k) =>
        Array.from({ length: 5 }, () =>
          new Promise<string[]>((resolve, reject) => {
            const w = new Worker(WORKER_SRC, {
              eval: true,
              workerData: {
                coreUrl: pathToFileURL(coreDist).href,
                dbUrl: pathToFileURL(dbDist).href,
                file,
                keyId: k.id,
                amount: usdc("0.15").toString(),
                count: 1,
                gate,
              },
            });
            w.once("message", resolve);
            w.once("error", reject);
          })
        )
      );
      // Give every worker time to open its connection and park on the gate.
      await new Promise((res) => setTimeout(res, 1500));
      const flag = new Int32Array(gate);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      const results = (await Promise.all(workers)).flat();

      expect(results.filter((x) => x.startsWith("WORKER_ERROR"))).toEqual([]);
      expect(results.filter((x) => x === "ok").length).toBe(6);
      expect(results.filter((x) => x === "DAILY_BUDGET_EXCEEDED").length).toBe(4);
      expect(usedToday(db, r.id)).toBe(usdc("0.90"));
    } finally {
      sqlite.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may briefly hold the WAL files; leaving a temp dir is harmless.
      }
    }
  }, 30_000);
});
