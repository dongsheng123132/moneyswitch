import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPaidFetchResult } from "../src/paid-fetch-result.ts";

const CJK = /[一-鿿]/;

function textOf(r: ReturnType<typeof formatPaidFetchResult>): string {
  return r.content.map((c) => c.text).join("\n---\n");
}

test("payment_unknown: bilingual, says do-not-retry in both languages, isError, includes envelope JSON", () => {
  const envelope = {
    status: "payment_unknown",
    code: "TIMEOUT_AFTER_PAYMENT",
    charged: "maybe",
    payment: { amount: "0.01", tx_hash: null, network: "eip155:10143" },
    reason: "A payment of 0.01 USDC was signed and sent ... Do NOT retry automatically",
  };
  const r = formatPaidFetchResult(200, envelope);
  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.match(text, CJK, "has a Chinese part");
  assert.match(text, /请不要自动重试/);
  assert.match(text, /Do NOT retry automatically/);
  assert.match(text, /TIMEOUT_AFTER_PAYMENT/);
  assert.match(text, /0\.01 USDC/);
  assert.match(text, /MAY have been charged/);
  // the raw envelope is still handed to the agent
  assert.equal(JSON.parse(r.content[1].text).status, "payment_unknown");
});

test("UPSTREAM_BODY_INCOMPLETE: says the money is spent, shows the tx hash, no-retry in both languages", () => {
  const r = formatPaidFetchResult(200, {
    status: "error",
    code: "UPSTREAM_BODY_INCOMPLETE",
    charged: "yes",
    payment: { amount: "0.01", tx_hash: "0xabc123", network: "eip155:10143", mock: false },
  });
  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.match(text, CJK);
  assert.match(text, /已经扣款/);
  assert.match(text, /You HAVE been charged/);
  assert.match(text, /0xabc123/);
  assert.match(text, /请不要自动重试/);
  assert.match(text, /Do NOT retry automatically/);
});

test("ok with charged=maybe (200 without a settlement header): result kept, bilingual warning appended, not an error", () => {
  const r = formatPaidFetchResult(200, { status: "ok", code: null, charged: "maybe", http_status: 200, body: "hi", payment: null });
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(r.content[0].text).body, "hi");
  const note = r.content[1].text;
  assert.match(note, CJK);
  assert.match(note, /you may have been charged/);
});

test("payment_failed PAYMENT_REJECTED (charged maybe): failure text plus the bilingual maybe-note", () => {
  const r = formatPaidFetchResult(200, { status: "payment_failed", code: "PAYMENT_REJECTED", charged: "maybe", reserved_until_expiry: true });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^paid_fetch failed: /);
  assert.match(textOf(r), /stays reserved until it is reconciled/);
});

test("unchanged behaviour: approval_required text, denied, plain ok and charged=no carry no extra note", () => {
  const approval = formatPaidFetchResult(200, { status: "approval_required", approval_id: "abc", charged: "no" });
  assert.match(approval.content[0].text, /approval_id=abc/);
  assert.equal(approval.isError, undefined);
  assert.equal(approval.content.length, 1);

  const denied = formatPaidFetchResult(200, { status: "denied", code: "HOST_NOT_ALLOWED", charged: "no" });
  assert.equal(denied.isError, true);
  assert.equal(denied.content.length, 1);
  assert.match(denied.content[0].text, /HOST_NOT_ALLOWED/);

  const ok = formatPaidFetchResult(200, { status: "ok", charged: "yes", payment: { amount: "0.01", tx_hash: "0x1", network: "n" } });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content.length, 1);

  const http500 = formatPaidFetchResult(500, null);
  assert.equal(http500.isError, true);
  assert.match(http500.content[0].text, /http_status/);
});
