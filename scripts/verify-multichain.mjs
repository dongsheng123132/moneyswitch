#!/usr/bin/env node
// One-shot, bounded testnet verification for the running Linux container.
// Bundle with esbuild --platform=node --format=esm --external:better-sqlite3
// and the same createRequire banner used by apps/server-pkg/build.mjs.
// No wallet, administrator token, migration, mainnet payment or automatic retry.
// MONEYSWITCH_VERIFY_CASE=solana chooses one fixed Solana Devnet test; unset keeps both.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openDb } from "@moneyswitch/db";
import { createMoneyKey, revokeMoneyKey, writeAudit, parseUsdcToMicros } from "@moneyswitch/core";

const API = "http://127.0.0.1:4020";
const SELLER = "https://x402.org/protected";
const TIMEOUT_MS = 360_000; // Includes the server's 30s probe + 300s paid deadline.
const MAX_RESPONSE_BYTES = 128 * 1024;
const CASES = [
  { network: "eip155:84532", purpose: "Base Sepolia connectivity test" },
  { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", purpose: "Solana Devnet connectivity test" },
];
const STATES = new Set(["ok", "denied", "approval_required", "payment_failed", "payment_unknown", "error"]);

function error(code, reason) { return { code, reason }; }
function emptyPayment() { return { tx_hash: null, amount: null, asset: null, pay_to: null }; }
function reasonText(value) {
  return typeof value === "string"
    ? value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/(?:mk_live_|ms_admin_)[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 300)
    : null;
}
function errorCode(value) { return typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value) ? value : "UNEXPECTED_RESPONSE"; }
function transactionHash(value, network) {
  if (typeof value !== "string") return null;
  return (network.startsWith("eip155:") ? /^0x[0-9a-fA-F]{64}$/ : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/).test(value) ? value : null;
}
function address(value, network) {
  if (typeof value !== "string") return null;
  return (network.startsWith("eip155:") ? /^0x[0-9a-fA-F]{40}$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(value) ? value : null;
}
function amount(value) {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) return null;
  const micros = parseUsdcToMicros(value);
  return micros > 0n && micros <= 10_000n ? value : null;
}

async function jsonResponse(fetchImpl, url, options) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_ENVELOPE");
  return { httpStatus: response.status, body };
}

function syncDirectory(directory) {
  // Linux is the deployment target; Windows cannot open a directory this way.
  if (process.platform !== "linux") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Publish a complete 0600 JSON once. The same-directory hard link is atomic
// and refuses an existing destination, unlike rename which can overwrite it.
function persistResult(file, result) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(result) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Exported only to permit offline verification with an isolated DB and fake HTTP responses. */
export async function verifyMultichain({ dataDir = "/data", fetchImpl = globalThis.fetch, mode } = {}) {
  const directory = path.resolve(dataDir);
  const databaseFile = path.join(directory, "moneyswitch.sqlite");
  const result = { status: "error", key_id: null, checks: [], error: null };
  if (mode !== undefined && mode !== "solana") {
    result.error = error("INVALID_VERIFY_MODE", "MONEYSWITCH_VERIFY_CASE must be unset or solana; no marker or database was written.");
    return result;
  }
  const cases = mode === "solana" ? [CASES[1]] : CASES;
  const markerName = mode === "solana" ? "multichain-check-20261011-sol-only" : "multichain-check-20261011-canonical";
  const markerFile = path.join(directory, `${markerName}.marker`);
  const resultFile = path.join(directory, `${markerName}.json`);
  const budget = BigInt(cases.length) * 10_000n;
  let markerOwned = false;
  let sqlite;
  let db;
  let plaintextKey;
  try {
    if (!fs.existsSync(databaseFile) || !fs.lstatSync(databaseFile).isFile()) {
      result.error = error("DATABASE_MISSING", "The existing moneyswitch.sqlite is required; no database was created.");
      return result;
    }
    if (fs.existsSync(markerFile) || fs.existsSync(resultFile)) {
      result.error = error("ALREADY_ATTEMPTED", "A previous verification marker or result exists. Refusing to retry or overwrite it.");
      return result;
    }
    let markerFd;
    try {
      markerFd = fs.openSync(markerFile, "wx", 0o600);
      markerOwned = true;
      fs.writeFileSync(markerFd, "one-shot multichain check 20261011\n", "utf8");
      fs.fsyncSync(markerFd);
    } finally { if (markerFd !== undefined) fs.closeSync(markerFd); }
    syncDirectory(directory);
    ({ db, sqlite } = openDb({ filePath: databaseFile, migrate: false }));
    // Require the already-deployed purpose migration; this script never runs DDL.
    sqlite.prepare("SELECT purpose FROM payments LIMIT 0").all();
    const issued = sqlite.transaction(() => {
      const key = createMoneyKey(db, {
        name: "Multichain connectivity test 20261011",
        networkMode: "testnet",
        totalBudget: budget, dailyBudget: budget, perRequestLimit: 10_000n,
        approvalThreshold: null, allowedHosts: ["x402.org:443"],
        canDelegate: false, maxPaymentsPerMinute: 2,
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      });
      writeAudit(db, "system", "multichain.check.started", { keyId: key.row.id, networks: cases.map((c) => c.network) });
      return key;
    })();
    result.key_id = issued.row.id;
    plaintextKey = issued.plaintextKey; // Never included in output, a file or audit.
    for (const test of cases) {
      const check = { network: test.network, status: "error", code: null, charged: null, http_status: null, error: null, payment: emptyPayment() };
      result.checks.push(check);
      let paid;
      try {
        // Exactly one paid HTTP invocation per network. Fetch does not follow redirects.
        paid = await jsonResponse(fetchImpl, `${API}/v1/fetch`, {
          method: "POST",
          headers: { authorization: `Bearer ${plaintextKey}`, "content-type": "application/json" },
          body: JSON.stringify({ url: SELLER, method: "GET", network: test.network, max_price: "0.01", purpose: test.purpose }),
        });
      } catch {
        check.status = "payment_unknown";
        check.error = error("CLIENT_RESULT_UNKNOWN", "The payment call did not yield a readable result. It may have charged; stop without retrying.");
        break;
      }
      const body = paid.body;
      check.status = STATES.has(body.status) ? body.status : "error";
      check.code = body.code == null ? null : errorCode(body.code);
      check.charged = ["yes", "no", "maybe"].includes(body.charged) ? body.charged : null;
      check.http_status = Number.isInteger(body.http_status) && body.http_status >= 100 && body.http_status <= 599 ? body.http_status : null;
      check.payment.tx_hash = transactionHash(body.payment?.tx_hash, test.network);
      check.payment.amount = amount(body.payment?.amount);
      // MoneySwitch's wire contract uses yes/no/maybe strings, not booleans.
      if (body.charged === "no") {
        check.status = "error";
        const detail = reasonText(body.reason) ?? "No payment was made.";
        check.error = error("UNPAID_RESPONSE", reasonText(`Unpaid response (upstream HTTP ${check.http_status ?? "unavailable"}): ${detail} Stop without retrying or switching chains.`));
        break;
      }
      if (paid.httpStatus !== 200 || body.status !== "ok" || body.charged !== "yes") {
        if (body.charged === "maybe" || body.status === "payment_unknown") check.status = "payment_unknown";
        check.error = error(errorCode(body.code), reasonText(body.reason) ?? "The payment was not confirmed. Stop without retrying or switching chains.");
        break;
      }
      if (body.payment?.network !== test.network || body.payment?.mock !== false || !check.payment.tx_hash || !check.payment.amount) {
        check.status = "error";
        check.error = error("PAYMENT_MISMATCH", "The reported chain, real transaction or amount does not match this bounded test. Stop without retrying.");
        break;
      }
      let history;
      try {
        history = await jsonResponse(fetchImpl, `${API}/v1/history?limit=20`, {
          headers: { authorization: `Bearer ${plaintextKey}` },
        });
      } catch {
        check.status = "error";
        check.error = error("HISTORY_UNAVAILABLE", "Payment was reported confirmed, but its ledger could not be read. Do not repeat the payment.");
        break;
      }
      const matches = history.httpStatus === 200 && Array.isArray(history.body.history)
        ? history.body.history.filter((p) => p && p.network === test.network && p.tx_hash === check.payment.tx_hash
          && p.amount === check.payment.amount && p.url === SELLER && p.method === "GET"
          && p.status === "settled" && p.purpose === test.purpose)
        : [];
      if (matches.length !== 1 || !address(matches[0].asset, test.network) || !address(matches[0].pay_to, test.network)) {
        check.status = "error";
        check.error = error("HISTORY_MISMATCH", "No unique settled ledger row confirms this network, purpose, transaction and amount. Do not repeat the payment.");
        break;
      }
      check.payment.asset = matches[0].asset;
      check.payment.pay_to = matches[0].pay_to;
      check.status = "ok";
    }
    result.status = result.checks.length === cases.length && result.checks.every((c) => c.status === "ok" && !c.error) ? "ok" : "error";
    if (result.status !== "ok") result.error = result.checks.at(-1)?.error ?? error("CHECK_FAILED", "The bounded test was not verified.");
  } catch (caught) {
    result.error = error(caught?.code === "EEXIST" ? "ALREADY_ATTEMPTED" : "SETUP_FAILED",
      "Verification setup failed. No automatic retry is allowed; inspect the retained marker and ledger.");
  } finally {
    if (db && result.key_id) {
      // Revoke first: an audit failure must never roll back key revocation.
      try { revokeMoneyKey(db, result.key_id); }
      catch { result.status = "error"; result.error = error("KEY_REVOKE_FAILED", "Dedicated key revocation failed; it expires within 20 minutes. Do not retry."); }
      try { writeAudit(db, "system", "multichain.check.finished", { keyId: result.key_id, status: result.status, networks: result.checks.map((c) => c.network) }); }
      catch { result.status = "error"; result.error = error("AUDIT_WRITE_FAILED", "Could not write the completion audit. Inspect the retained result; do not retry."); }
    }
    plaintextKey = undefined;
    try { sqlite?.close(); }
    catch { result.status = "error"; result.error = error("DATABASE_CLOSE_FAILED", "Database close failed after verification; do not retry."); }
    if (markerOwned) {
      try { persistResult(resultFile, result); }
      catch { result.status = "error"; result.error = error("RESULT_WRITE_FAILED", "Could not persist the result. The one-shot marker is retained; do not retry."); }
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await verifyMultichain({ mode: process.env.MONEYSWITCH_VERIFY_CASE });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "ok" ? 0 : 1;
}
