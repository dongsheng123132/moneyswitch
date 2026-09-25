// Makes ONE real x402 payment through MoneySwitch (testnet): paid_fetch of demo-seller /premium-report (0.01 USDC).
// Usage (from repo root): node tools/m6/first-payment.mjs
import { readFileSync } from "node:fs";
const key = readFileSync(".data/testnet/demo-key.txt", "utf8").trim();
const res = await fetch("http://127.0.0.1:4020/v1/fetch", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ url: "http://127.0.0.1:4021/premium-report" }),
});
const j = await res.json();
console.log(JSON.stringify({ status: j.status, code: j.code, http_status: j.http_status, body: j.body, payment: j.payment, remaining_today: j.remaining_today }, null, 2));
