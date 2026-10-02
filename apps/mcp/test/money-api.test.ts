import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MoneyApiTransportError, parseTimeoutMs, requestMoneyApi } from "../src/money-api.ts";
import { formatPaidFetchTransportError } from "../src/paid-fetch-result.ts";

const CJK = /[一-鿿]/;

let server: http.Server;
let base: string;
const seen: Array<{ method?: string; url?: string; auth?: string; contentType?: string; body: string }> = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      switch (req.url) {
        case "/slow":
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok", late: true }));
          }, 1500);
          return;
        case "/denied":
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "error", code: "KEY_INVALID", charged: "no" }));
          return;
        case "/nonjson":
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bad Gateway");
          return;
        case "/reset":
          req.socket.destroy();
          return;
        case "/truncated":
          res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
          res.write('{"status":"ok","bo');
          setTimeout(() => req.socket.destroy(), 30);
          return;
        case "/hang":
          return; // never answers
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ echo: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (path: string, over: Partial<Parameters<typeof requestMoneyApi>[0]> = {}) =>
  requestMoneyApi({ baseUrl: base, path, method: "POST", apiKey: "mk_live_test", timeoutMs: 5000, ...over });

test("sends the key as a bearer token, the body as JSON, and returns status + parsed JSON", async () => {
  seen.length = 0;
  const r = await call("/echo", { body: { url: "https://example.com", max_price: "0.05" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { echo: true });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].auth, "Bearer mk_live_test");
  assert.equal(seen[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(seen[0].body), { url: "https://example.com", max_price: "0.05" });
});

test("GET without a body sends none", async () => {
  seen.length = 0;
  const r = await call("/echo", { method: "GET" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, "");
});

test("a response that arrives late is delivered (no premature give-up while the server is still working)", async () => {
  const started = Date.now();
  const r = await call("/slow");
  assert.equal(r.status, 200);
  assert.equal(r.json.late, true);
  assert.ok(Date.now() - started >= 1400);
});

test("non-2xx JSON is returned as-is for the caller to interpret; non-JSON gives json null", async () => {
  const denied = await call("/denied");
  assert.equal(denied.status, 401);
  assert.equal(denied.json.charged, "no");
  const bad = await call("/nonjson");
  assert.equal(bad.status, 502);
  assert.equal(bad.json, null);
});

test("connection refused -> MoneyApiTransportError kind=not_sent (nothing was sent)", async () => {
  // a port nobody listens on: bind then close
  const tmp = http.createServer();
  await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
  const port = (tmp.address() as AddressInfo).port;
  await new Promise<void>((resolve) => tmp.close(() => resolve()));
  await assert.rejects(
    requestMoneyApi({ baseUrl: `http://127.0.0.1:${port}`, path: "/v1/fetch", method: "POST", apiKey: "k", body: {}, timeoutMs: 3000 }),
    (e: unknown) => {
      assert.ok(e instanceof MoneyApiTransportError);
      assert.equal(e.kind, "not_sent");
      assert.equal(e.code, "ECONNREFUSED");
      return true;
    }
  );
});

test("an invalid MONEY_API_BASE is not_sent too", async () => {
  await assert.rejects(
    requestMoneyApi({ baseUrl: "not a url", path: "/x", method: "GET", apiKey: "k", timeoutMs: 1000 }),
    (e: unknown) => e instanceof MoneyApiTransportError && e.kind === "not_sent" && e.code === "ERR_INVALID_URL"
  );
});

test("connection cut after the request was received -> kind=unknown (the server may have processed it)", async () => {
  await assert.rejects(call("/reset"), (e: unknown) => {
    assert.ok(e instanceof MoneyApiTransportError);
    assert.equal(e.kind, "unknown");
    assert.equal(e.timedOut, false);
    return true;
  });
});

test("response cut off mid-body -> kind=unknown", async () => {
  await assert.rejects(call("/truncated"), (e: unknown) => e instanceof MoneyApiTransportError && e.kind === "unknown");
});

test("our own deadline: a server that never answers -> kind=unknown, timedOut, after about timeoutMs", async () => {
  const started = Date.now();
  await assert.rejects(call("/hang", { timeoutMs: 400 }), (e: unknown) => {
    assert.ok(e instanceof MoneyApiTransportError);
    assert.equal(e.kind, "unknown");
    assert.equal(e.timedOut, true);
    assert.match(e.message, /no complete response within 400 ms/);
    return true;
  });
  const took = Date.now() - started;
  assert.ok(took >= 350 && took < 3000, `took ${took}ms`);
});

test("parseTimeoutMs: positive finite numbers only, anything else falls back (a timeout cannot be disabled by a typo)", () => {
  assert.equal(parseTimeoutMs(undefined, 123), 123);
  assert.equal(parseTimeoutMs("", 123), 123);
  assert.equal(parseTimeoutMs("  ", 123), 123);
  assert.equal(parseTimeoutMs("0", 123), 123);
  assert.equal(parseTimeoutMs("-5", 123), 123);
  assert.equal(parseTimeoutMs("banana", 123), 123);
  assert.equal(parseTimeoutMs("Infinity", 123), 123);
  assert.equal(parseTimeoutMs("99999999999", 123), 123);
  assert.equal(parseTimeoutMs("45000", 123), 45000);
  assert.equal(parseTimeoutMs("1500.9", 123), 1500);
});

test("transport error, request possibly sent: bilingual, says the outcome is unknown, do not retry, check money_history", () => {
  const err = new MoneyApiTransportError("no complete response within 600000 ms", "unknown", undefined, true);
  const r = formatPaidFetchTransportError(err);
  assert.equal(r.isError, true);
  const text = r.content.map((c) => c.text).join("\n");
  assert.match(text, CJK);
  assert.match(text, /结果未知/);
  assert.match(text, /请不要自动重试/);
  assert.match(text, /UNKNOWN/);
  assert.match(text, /MAY have been charged/);
  assert.match(text, /Do NOT retry automatically/);
  assert.match(text, /money_history/);
  assert.match(text, /no complete response within 600000 ms/);
});

test("transport error, request never sent: says nothing was charged and that retrying is safe", () => {
  const err = new MoneyApiTransportError("connect ECONNREFUSED 127.0.0.1:4020", "not_sent", "ECONNREFUSED");
  const r = formatPaidFetchTransportError(err);
  assert.equal(r.isError, true);
  const text = r.content.map((c) => c.text).join("\n");
  assert.match(text, CJK);
  assert.match(text, /没有扣款/);
  assert.match(text, /nothing was charged/);
  assert.doesNotMatch(text, /Do NOT retry/);
});

test("a non-MoneyApiTransportError (anything unexpected) is treated as outcome-unknown, never as safe", () => {
  const r = formatPaidFetchTransportError(new Error("boom"));
  const text = r.content.map((c) => c.text).join("\n");
  assert.match(text, /Do NOT retry automatically/);
});
