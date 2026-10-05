import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, listHistoryForKey, usedToday, usedTotal } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { x402Client } from "@x402/core/client";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * A seller's quoted price is the seller's own text and ends up in money arithmetic: a NEGATIVE price written into a reservation
 * row would lower the key's used budget while it is held, and let concurrent payments walk past the key's limits.
 *
 * MoneySwitch refuses a price that is not a positive plain integer (atomic USDC units) in its own code, before the wallet is
 * leased, a payments row is written or anything is signed: PRICE_INVALID, status "denied", charged "no". It does not rely on
 * @x402/core's spendControls, which today drops most such prices one step earlier (but lets "0" through).
 */

const PAY_TO = EthersWallet.createRandom().address;
const BAD_PRICES = ["0", "-5", "1.5", "abc", ""];

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let seller: StubSeller;

beforeAll(async () => {
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorPort = (facilitator.server.address() as { port: number }).port;
  seller = await startStubSeller({ facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`, payTo: PAY_TO });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-price-invalid-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir, { protect: false });
  await wallet.createWithPhrase(); // auto-unlock, like every wallet the server creates
  adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
  };
  const ctx: AppContext = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.ready();
}, 30000);

afterAll(async () => {
  await app?.close();
  await seller?.close();
  await facilitator?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  seller.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const keyIds = new Map<string, string>();

async function createKey() {
  const res = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      name: "e2e",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: [`127.0.0.1:${seller.port}`],
    },
  });
  expect(res.statusCode).toBe(200);
  keyIds.set(res.json().key, res.json().id);
  return res.json().key as string;
}

async function fetchVia(key: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/fetch",
    headers: { authorization: `Bearer ${key}` },
    payload: { url: `${seller.url}/item` },
  });
  return { res, body: res.json() };
}

const payments = (key: string) => listHistoryForKey(db, keyIds.get(key)!, 50);

/** Nothing happened that could cost money or touch the key's budget. */
function expectNothingHappened(key: string, body: Record<string, unknown>, leased: { mock: { calls: unknown[] } }) {
  expect(body.charged).toBe("no");
  expect(body.payment).toBeNull();
  expect(seller.requests.filter((r) => r.paid), "no signed payment ever left the process").toHaveLength(0);
  expect(seller.settleCalls(), "nothing was settled, so nothing happened on chain").toBe(0);
  expect(payments(key), "no payments row, not even a released one").toHaveLength(0);
  expect(usedToday(db, keyIds.get(key)!), "no budget used today").toBe(0n);
  expect(usedTotal(db, keyIds.get(key)!), "no budget used in total").toBe(0n);
  expect(body.remaining_today, "the daily budget is untouched").toBe("5");
  expect(body.remaining_total, "the total budget is untouched").toBe("10");
  expect(leased.mock.calls, "the wallet's signer was never leased").toHaveLength(0);
  expect(wallet.inFlight).toBe(0);
}

describe("a seller that quotes a price that is not a positive whole number is refused before anything is reserved or signed", () => {
  describe("with @x402/core's spendControls switched off (as an upstream change could do): our own check refuses it", () => {
    beforeEach(() => {
      // applySpendControls is what makes @x402/core drop non-/^\d+$/ prices today. Let every requirement through to our hook.
      vi.spyOn(x402Client.prototype as unknown as { applySpendControls: (v: number, r: unknown[]) => unknown[] }, "applySpendControls").mockImplementation(
        (_version, requirements) => requirements
      );
    });

    for (const bad of BAD_PRICES) {
      it(`price ${JSON.stringify(bad)}: PRICE_INVALID, denied, charged no, nothing reserved, nothing signed, nothing sent`, async () => {
        seller.setBehavior({ amount: bad });
        const key = await createKey();
        const leased = vi.spyOn(wallet, "leaseSigner");
        const { res, body } = await fetchVia(key);
        expect(res.statusCode).toBe(200);
        expect(body).toMatchObject({ status: "denied", code: "PRICE_INVALID", charged: "no" });
        expectNothingHappened(key, body, leased);
      });
    }
  });

  describe("with the SDK as it is: whichever layer refuses it, nothing is reserved, signed or sent", () => {
    for (const bad of BAD_PRICES) {
      it(`price ${JSON.stringify(bad)}: charged no, no payments row, no budget used, no signed payment, wallet never leased`, async () => {
        seller.setBehavior({ amount: bad });
        const key = await createKey();
        const leased = vi.spyOn(wallet, "leaseSigner");
        const { res, body } = await fetchVia(key);
        expect(res.statusCode).toBe(200);
        expect(["denied", "error"], `status ${body.status}, code ${body.code}`).toContain(body.status);
        if (bad === "0") {
          // the one bad price @x402/core lets through: it is our check that stops it
          expect(body).toMatchObject({ status: "denied", code: "PRICE_INVALID", charged: "no" });
        }
        expectNothingHappened(key, body, leased);
      });
    }
  });

  it("an honest price is still paid and recorded exactly as before", async () => {
    const key = await createKey();
    const { body } = await fetchVia(key);
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    expect(body.payment.amount).toBe("0.01");
    const rows = payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(10000n);
    expect(rows[0].status).toBe("settled");
    expect(usedTotal(db, keyIds.get(key)!)).toBe(10000n);
    expect(seller.requests.filter((r) => r.paid)).toHaveLength(1);
  });
});
