import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { x402Client } from "@x402/core/client";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import {
  createMoneyKey,
  parseUsdcToMicros,
  usedToday,
  usedTotal,
  listHistoryForKey,
  MoneySwitchError,
  type MoneyKeyRow,
} from "@moneyswitch/core";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import type Database from "better-sqlite3";
import { performPaidFetch, parsePositiveAtomicAmount } from "../src/client.js";
import { TESTNET } from "../src/networks.js";

/**
 * A seller's quoted price is the seller's own text, and it ends up in money arithmetic (a reservation row that every limit check
 * sums). MoneySwitch refuses a price that is not a positive plain integer BEFORE it leases the wallet, writes the reservation or
 * signs anything - in its own code, not because @x402/core's spendControls happens to drop most such prices one step earlier.
 */

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const BAD_PRICES = ["0", "-5", "1.5", "abc", ""];

describe("parsePositiveAtomicAmount: what counts as a price", () => {
  it("accepts a plain decimal integer above zero (leading zeros are still a plain integer)", () => {
    expect(parsePositiveAtomicAmount("1")).toBe(1n);
    expect(parsePositiveAtomicAmount("10000")).toBe(10000n);
    expect(parsePositiveAtomicAmount("007")).toBe(7n);
    expect(parsePositiveAtomicAmount("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
  });

  it("refuses zero, negatives, fractions, exponents, hex, signs, whitespace, non-ASCII digits and empty text", () => {
    for (const bad of ["0", "00", "-5", "-0", "+5", "1.5", "5.", ".5", "1e3", "0x10", "abc", "", " ", " 5", "5 ", "5\n", "\n5", "1_000", "٣", "１２", "NaN", "Infinity"]) {
      expect(parsePositiveAtomicAmount(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses anything that is not a string (a JSON number, a bigint, null, a missing amount, an object)", () => {
    for (const bad of [5, -5, 0, 1.5, 5n, null, undefined, true, {}, ["5"], { toString: () => "5" }]) {
      expect(parsePositiveAtomicAmount(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("performPaidFetch refuses a bad price before the wallet is leased, anything is reserved or anything is signed", () => {
  let tmpDir: string;
  let db: MoneySwitchDb;
  let sqlite: Database.Database;
  let wallet: LocalWalletDriver;
  let server: http.Server;
  let sellerUrl: string;
  let sellerHost: string;
  let quotedAmount = "10000";
  let seen: { paid: boolean }[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-price-guard-"));
    wallet = new LocalWalletDriver(tmpDir, { protect: false });
    await wallet.createWithPhrase();
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const paid = typeof (req.headers["payment-signature"] ?? req.headers["x-payment"]) === "string";
        seen.push({ paid });
        if (paid) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ delivered: true }));
          return;
        }
        const url = `${sellerUrl}${req.url}`;
        const paymentRequired = {
          x402Version: 2,
          error: "Payment required",
          resource: { url, description: "price guard seller", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network: TESTNET.caip2,
              amount: quotedAmount,
              asset: TESTNET.usdcAddress,
              payTo: PAY_TO,
              maxTimeoutSeconds: 60,
              extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
            },
          ],
        };
        res.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired as never),
        });
        res.end(JSON.stringify(paymentRequired));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${port}`;
    sellerHost = `127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let key: MoneyKeyRow;
  beforeEach(() => {
    const opened = openDb({ filePath: ":memory:" });
    db = opened.db;
    sqlite = opened.sqlite;
    key = createMoneyKey(db, {
      name: "price-guard",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("5"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: [sellerHost],
    }).row;
    seen = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  const fetchPaid = () =>
    performPaidFetch(db, sqlite, key, wallet, { url: `${sellerUrl}/item`, host: sellerHost, method: "GET" });

  /** What must be true after a refused price: no signer lease, no payments row, no budget touched, nothing paid to the seller. */
  function expectNothingHappened(leased: { mock: { calls: unknown[] } }) {
    expect(leased.mock.calls, "the wallet's signer was never leased").toHaveLength(0);
    expect(listHistoryForKey(db, key.id, 50), "no payments row was written").toHaveLength(0);
    expect(usedToday(db, key.id), "no budget was used today").toBe(0n);
    expect(usedTotal(db, key.id), "no budget was used in total").toBe(0n);
    expect(seen.filter((r) => r.paid), "no signed payment reached the seller").toHaveLength(0);
    expect(wallet.inFlight).toBe(0);
  }

  describe("when the SDK's spendControls does not drop the price first (it is switched off here, as an upstream change could do)", () => {
    beforeEach(() => {
      // x402Client.applySpendControls is what makes @x402/core drop non-/^\d+$/ prices today. Make it let every requirement through.
      vi.spyOn(x402Client.prototype as unknown as { applySpendControls: (v: number, r: unknown[]) => unknown[] }, "applySpendControls").mockImplementation(
        (_version, requirements) => requirements
      );
    });

    for (const bad of BAD_PRICES) {
      it(`price ${JSON.stringify(bad)}: PRICE_INVALID, no lease, no payments row, no budget touched, nothing sent`, async () => {
        quotedAmount = bad;
        const leased = vi.spyOn(wallet, "leaseSigner");
        const err = await fetchPaid().then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(MoneySwitchError);
        expect((err as MoneySwitchError).code).toBe("PRICE_INVALID");
        expectNothingHappened(leased);
      });
    }

    it("a negative price does not lower what the key has used (which would let later payments past the daily and total budgets)", async () => {
      quotedAmount = "-1000000";
      await fetchPaid().catch(() => undefined);
      expect(usedToday(db, key.id)).toBe(0n);
      // the key's per-request limit is still enforced for an honest price right afterwards
      quotedAmount = "2000000"; // 2 USDC > the 1 USDC limit
      const err = await fetchPaid().then(
        () => null,
        (e: unknown) => e
      );
      expect((err as MoneySwitchError).code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
      expect(listHistoryForKey(db, key.id, 50)).toHaveLength(0);
      expect(seen.filter((r) => r.paid)).toHaveLength(0);
    });
  });

  describe("with the SDK as it is (spendControls drops most bad prices before our hook; \"0\" is the one it lets through)", () => {
    for (const bad of BAD_PRICES) {
      it(`price ${JSON.stringify(bad)}: refused as a MoneySwitchError, no lease, no payments row, no budget touched, nothing sent`, async () => {
        quotedAmount = bad;
        const leased = vi.spyOn(wallet, "leaseSigner");
        const err = await fetchPaid().then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(MoneySwitchError);
        if (bad === "0") expect((err as MoneySwitchError).code).toBe("PRICE_INVALID");
        expectNothingHappened(leased);
      });
    }
  });

  describe("an honest price is paid as before", () => {
    for (const good of ["1", "10000", "1000000"]) {
      it(`price ${good}: reserved and signed, the payments row carries exactly that amount`, async () => {
        quotedAmount = good;
        const leased = vi.spyOn(wallet, "leaseSigner");
        const result = await fetchPaid();
        expect(result.paymentId).toBeTruthy();
        expect(leased).toHaveBeenCalledTimes(1);
        const rows = listHistoryForKey(db, key.id, 50);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(BigInt(good));
        expect(usedTotal(db, key.id)).toBe(BigInt(good));
        expect(seen.filter((r) => r.paid), "the signed payment was sent").toHaveLength(1);
      });
    }
  });
});
