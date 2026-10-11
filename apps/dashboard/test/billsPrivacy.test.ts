import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { PaymentRow } from "../src/api.ts";

const storage = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage });

let Bills: typeof import("../src/pages/BillsPage.tsx");
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let strings: typeof import("../src/i18n/strings/bills.ts").billsStrings;

before(async () => {
  Bills = await import("../src/pages/BillsPage.tsx");
  ({ LangProvider } = await import("../src/i18n/index.tsx"));
  ({ billsStrings: strings } = await import("../src/i18n/strings/bills.ts"));
});
beforeEach(() => storage.clear());

const PURPOSE = "Confidential acquisition project research";
const URL = "https://data.example.com/projects/secret-acquisition?customer=PrivateClient";
const payment = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  id: "payment-1",
  key_id: "key-research",
  key_name: "Research Agent",
  purpose: PURPOSE,
  url: URL,
  host: "data.example.com:443",
  method: "GET",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  network_kind: "testnet",
  asset: "DevnetUSDCMint",
  pay_to: "RecipientSolanaPublicAddress",
  amount: "0.000001",
  status: "settled",
  tx_hash: "ConfirmedSolanaTransactionSignature",
  error_code: null,
  approval_id: null,
  created_at: "2026-10-11T02:00:00.000Z",
  updated_at: "2026-10-11T02:00:01.000Z",
  kind: "fetch",
  ...over,
});
const render = (element: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en") => {
  storage.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location: "/bills" }, element)));
};
const table = (payments: PaymentRow[], showPurpose = false) => render(h(Bills.BillsTable, {
  payments,
  keyNames: new Map([["key-research", "Old label"]]),
  chainLabels: new Map([[payment().network, "Solana Devnet"]]),
  showPurpose,
}));

describe("bills: optional attribution and private audit details", () => {
  it("a shared overview renders only the host; private paths, notes, recipient and tx do not exist even in attributes", () => {
    const html = table([payment()]);
    assert.ok(html.includes("Research Agent") && !html.includes("Old label"));
    assert.ok(html.includes("data.example.com:443"));
    for (const secret of [PURPOSE, "secret-acquisition", "PrivateClient", payment().pay_to, payment().tx_hash]) {
      assert.ok(secret && !html.includes(secret), String(secret));
    }
    assert.match(html, /aria-expanded="false"/);
    assert.ok(!html.includes('data-testid="bill-details"'));
    assert.ok(html.includes("0.000001 USDC"), "a one-micro-USDC charge must not appear as zero");
    assert.ok(html.includes("Solana Devnet") && html.includes('data-network-kind="testnet"'));
  });

  it("showing purposes is explicit; employees can omit them and retain an ordinary payable ledger row", () => {
    assert.ok(table([payment()], true).includes(PURPOSE));
    const html = table([payment({ purpose: null }), payment({ id: "old-payment", purpose: undefined, key_name: null })], true);
    assert.equal((html.match(/Not provided/g) ?? []).length, 2);
    assert.equal((html.match(/data-charged="yes"/g) ?? []).length, 2);
    assert.ok(html.includes("Old label"), "old responses can still resolve a key label from the key list");
    assert.equal(Bills.billKeyName(payment({ key_name: null }), new Map()), "key-rese");
  });

  it("an auditor can request full recipient, asset, transaction and URL details while leaving purposes hidden", () => {
    const p = payment({ approval_id: "approved-request-1" });
    const details = (showPurpose: boolean) => render(h(Bills.BillsPaymentDetails, { payment: p, keyName: "Research Agent", chainLabel: "Solana Devnet", showPurpose }));
    const hidden = details(false);
    for (const field of [p.id, p.key_id, p.pay_to, p.asset, p.tx_hash!, p.url, p.approval_id!]) assert.ok(hidden.includes(field), field);
    assert.ok(hidden.includes("Confirmed") && !hidden.includes(PURPOSE));
    assert.ok(details(true).includes(PURPOSE));
  });

  it("reserved and unknown charges stay uncertain with a visible reminder against paying again", () => {
    const html = table([
      payment({ id: "in-flight", status: "reserved", tx_hash: null }),
      payment({ id: "unknown", status: "unknown", tx_hash: null, error_code: "TIMEOUT_AFTER_PAYMENT" }),
    ]);
    assert.equal((html.match(/data-charged="maybe"/g) ?? []).length, 2);
    assert.equal((html.match(/Being checked · do not pay again/g) ?? []).length, 2);
    assert.ok(html.includes("TIMEOUT_AFTER_PAYMENT"));
  });

  it("a small Solana test payment remains visible and never adds to a real-money Base balance", () => {
    const testPayment = payment();
    const mainPayment = payment({ id: "base-real", network: "eip155:8453", network_kind: "mainnet", amount: "2" });
    assert.deepEqual(Bills.billsTotalsByKind([mainPayment, testPayment]), [
      { kind: "mainnet", total: "2" },
      { kind: "testnet", total: "0.000001" },
    ]);
    const html = render(h(Bills.BillsSummary, { payments: [mainPayment, testPayment] }));
    assert.ok(html.includes("0.000001 USDC"));
    assert.ok(!html.includes("2.000001"));
  });

  it("CSV omits private URL and purpose by default; full export retains them with spreadsheet injection protection", () => {
    const p = payment({ purpose: "=1+1" });
    const safe = Bills.billsCsv([p], new Map());
    assert.ok(safe.includes("data.example.com:443") && safe.includes(p.pay_to) && safe.includes(p.asset));
    assert.ok(!safe.includes("secret-acquisition") && !safe.includes("PrivateClient") && !safe.includes("=1+1"));
    const full = Bills.billsCsv([p], new Map(), true);
    assert.ok(full.includes(p.url));
    assert.ok(full.includes(",'=1+1,"), "caller notes cannot execute as spreadsheet formulas");
  });

  it("the page starts with unchecked display/export options and explains administrator access and optional unverified purposes", () => {
    for (const lang of ["en", "zh"] as const) {
      const html = render(h(Bills.default), lang);
      const inputs = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
      assert.equal(inputs.length, 2);
      assert.ok(inputs.every((input) => !input.includes("checked")));
      assert.ok(html.includes(strings[lang].privacyHint));
      assert.ok(html.includes(strings[lang].purposeHint));
    }
  });

  it("every overview value has a localized field label for the narrow-screen record layout", () => {
    const html = table([payment()]);
    for (const field of ["Time", "Agent / Key", "Amount", "Purpose", "Request host", "Chain", "Charged", "Details"]) {
      assert.ok(html.includes(`data-label="${field}"`), field);
    }
  });
});
