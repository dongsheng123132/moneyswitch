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
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");
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
    assert.ok(visibleText(html).includes("0.000001 USDC"), "a one-micro-USDC charge must not appear as zero");
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
    assert.equal((html.match(/Do not pay again/g) ?? []).length, 4, "both pending rows have a visible reminder and an explanatory title");
    assert.ok(!html.includes("TIMEOUT_AFTER_PAYMENT"), "raw transport errors stay out of the review overview");
    assert.ok(visibleText(html).includes("Processing") && visibleText(html).includes("To check"));
    const details = render(h(Bills.BillsPaymentDetails, { payment: payment({ status: "unknown", tx_hash: null, error_code: "TIMEOUT_AFTER_PAYMENT" }), keyName: "Research Agent", chainLabel: "Solana Devnet" }));
    assert.ok(details.includes("TIMEOUT_AFTER_PAYMENT") && details.includes("Result unknown"), "the auditor can still inspect the actual error and unchanged status on demand");
  });

  it("a small Solana test payment remains visible and never adds to a real-money Base balance", () => {
    const testPayment = payment();
    const mainPayment = payment({ id: "base-real", network: "eip155:8453", network_kind: "mainnet", amount: "2" });
    assert.deepEqual(Bills.billsTotalsByKind([mainPayment, testPayment]), [
      { kind: "mainnet", total: "2" },
      { kind: "testnet", total: "0.000001" },
    ]);
    const html = render(h(Bills.BillsSummary, { payments: [mainPayment, testPayment] }));
    assert.ok(visibleText(html).includes("0.000001 USDC"));
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
    for (const field of ["Time", "Agent / Key", "Amount", "Purpose", "Request host", "Network", "Status", "Details"]) {
      assert.ok(html.includes(`data-label="${field}"`), field);
    }
  });

  it("unknown and processing amounts are separately reviewable by network type and cannot inflate confirmed totals", () => {
    const rows = [
      payment({ id: "real-paid", network_kind: "mainnet", amount: "2", status: "settled" }),
      payment({ id: "real-unknown", network_kind: "mainnet", amount: "7", status: "unknown" }),
      payment({ id: "test-processing", amount: "8", status: "reserved" }),
      payment({ id: "test-paid", amount: "0.000001" }),
      payment({ id: "failed", network_kind: "mainnet", amount: "100", status: "failed" }),
    ];
    assert.deepEqual(Bills.billsTotalsByKind(rows), [{ kind: "mainnet", total: "2" }, { kind: "testnet", total: "0.000001" }]);
    assert.deepEqual(Bills.billsPendingTotalsByKind(rows), [{ kind: "mainnet", total: "7" }, { kind: "testnet", total: "8" }]);
    const html = render(h(Bills.BillsSummary, { payments: rows, onReview() {} }));
    assert.ok(html.includes('data-testid="pending-summary"'));
    assert.ok(visibleText(html).includes("2 payments to check"));
    assert.ok(/data-pending-kind="mainnet"[^]*?7 USDC/.test(html));
    assert.ok(/data-pending-kind="testnet"[^]*?8 USDC/.test(html));
    assert.ok(!visibleText(html).includes("15 USDC") && !visibleText(html).includes("9 USDC"));
    assert.ok(visibleText(html).includes("Review payments"));
  });

  it("a pending-only network shows zero confirmed spending and the payment remains unknown", () => {
    const row = payment({ status: "unknown", amount: "0.01", tx_hash: null });
    assert.deepEqual(Bills.billsTotalsByKind([row]), [{ kind: "testnet", total: "0" }]);
    assert.deepEqual(Bills.billsPendingTotalsByKind([row]), [{ kind: "testnet", total: "0.01" }]);
    assert.equal(row.status, "unknown");
    const settled = render(h(Bills.BillsSummary, { payments: [payment()] }));
    assert.ok(!settled.includes('data-testid="pending-summary"'));
  });

  it("status tabs expose actual record counts and let reviewers focus on the unresolved pair", () => {
    const rows = [payment(), payment({ status: "unknown" }), payment({ status: "reserved" }), payment({ status: "failed" })];
    const html = render(h(Bills.BillsStatusFilter, { payments: rows, value: "maybe", onChange() {} }));
    const buttons = [...html.matchAll(/<button[^>]*data-status-filter="([^"]+)"[^>]*>([^]*?)<\/button>/g)];
    assert.deepEqual(buttons.map((match) => [match[1], visibleText(match[2])]), [["all", "All payments4"], ["maybe", "To check2"], ["yes", "Paid1"], ["no", "Not charged1"]]);
    assert.match(html, /aria-pressed="true" data-status-filter="maybe"/);
  });
});
