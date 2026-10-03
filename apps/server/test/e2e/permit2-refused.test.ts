import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, listHistoryForKey } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * MoneySwitch signs EIP-3009 (transferWithAuthorization) payments and nothing else.
 *
 * Why it matters: the startup sweep of stale reservations treats a reservation that has NO recorded auth_* (from / nonce /
 * validBefore) as "never signed" and releases the budget it held. @x402/evm 2.27 signs a Permit2 authorization when a
 * requirement says extra.assetTransferMethod = "permit2", and that payload carries no `authorization` at all - so such a
 * payment would be signed and sent, leave a row without auth_*, and be released as "never signed" after a crash. The policy
 * filter therefore accepts only requirements whose assetTransferMethod is absent or "eip3009".
 */

const PAY_TO = EthersWallet.createRandom().address;

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-permit2-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("e2e-test-password");
  await wallet.unlock("e2e-test-password");
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

/** The decoded PAYMENT-SIGNATURE of the (only) paid request the seller saw. */
function paidPayload(): { accepted: { extra?: Record<string, unknown> }; payload: Record<string, unknown> } {
  const paid = seller.requests.filter((r) => r.paid);
  expect(paid).toHaveLength(1);
  return decodePaymentSignatureHeader(paid[0].headers["payment-signature"] as string) as never;
}

describe("a seller that asks for a Permit2 payment is refused before anything is reserved or signed", () => {
  it("permit2 only: UNSUPPORTED_PAYMENT, charged no, nothing reserved, nothing signed, nothing sent", async () => {
    seller.setBehavior({ assetTransferMethod: "permit2" });
    const key = await createKey();
    const leased = vi.spyOn(wallet, "leaseSigner");
    const { res, body } = await fetchVia(key);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ status: "denied", code: "UNSUPPORTED_PAYMENT", charged: "no" });
    expect(seller.requests.filter((r) => r.paid), "no signed payment ever left the process").toHaveLength(0);
    expect(await payments(key), "no reservation was made").toHaveLength(0);
    expect(leased, "the wallet's signer was never even leased").not.toHaveBeenCalled();
    expect(wallet.inFlight).toBe(0);
    leased.mockRestore();
  });

  it("an assetTransferMethod this client does not know is refused the same way", async () => {
    seller.setBehavior({ assetTransferMethod: "permit3" });
    const key = await createKey();
    const { body } = await fetchVia(key);
    expect(body).toMatchObject({ status: "denied", code: "UNSUPPORTED_PAYMENT", charged: "no" });
    expect(seller.requests.filter((r) => r.paid)).toHaveLength(0);
    expect(await payments(key)).toHaveLength(0);
  });

  it("a seller that offers BOTH, permit2 first: the EIP-3009 requirement is the one that is paid, and its authorization is recorded", async () => {
    seller.setBehavior({ assetTransferMethod: "permit2", alsoOfferEip3009: true });
    const key = await createKey();
    const { body } = await fetchVia(key);
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    const sent = paidPayload();
    expect(sent.accepted.extra?.assetTransferMethod, "the accepted requirement is the plain one").toBeUndefined();
    expect(sent.payload).toHaveProperty("authorization");
    expect(sent.payload).not.toHaveProperty("permit2Authorization");
    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(rows[0].authFrom, "auth_* is recorded, so the crash sweep can tell this payment was signed").toBe(wallet.getAddress());
  });

  it("assetTransferMethod \"eip3009\" spelled out is accepted and paid as before", async () => {
    seller.setBehavior({ assetTransferMethod: "eip3009" });
    const key = await createKey();
    const { body } = await fetchVia(key);
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    expect(paidPayload().payload).toHaveProperty("authorization");
    const rows = await payments(key);
    expect(rows[0].authFrom).toBe(wallet.getAddress());
  });

  it("no assetTransferMethod at all (every seller until now): paid as before", async () => {
    const key = await createKey();
    const { body } = await fetchVia(key);
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    expect(paidPayload().payload).toHaveProperty("authorization");
    expect((await payments(key))[0].authFrom).toBe(wallet.getAddress());
  });
});
