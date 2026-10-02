import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MoneySwitchClient, MoneySwitchTransportError } from "../../src/moneyswitch.js";

/**
 * /v1/fetch answers only after the whole paid exchange (server probe deadline +
 * paid deadline = up to ~330 s). The client must wait for that verdict, and when
 * the exchange itself breaks it must say the outcome is UNKNOWN rather than hand
 * the model a bare "fetch failed" that looks safe to retry.
 */

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
});

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const ARGS = { url: "/x", method: "POST", max_price: "0.05" };

describe("MoneySwitchClient transport", () => {
  it("delivers an envelope that arrives late (no premature give-up) and sends key + JSON body", async () => {
    let seen: { auth?: string; body?: string } = {};
    const url = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "payment_unknown", code: "TIMEOUT_AFTER_PAYMENT", charged: "maybe", remaining_today: "1", remaining_total: "2" }));
        }, 1200);
      });
    });
    const envelope = await new MoneySwitchClient(url, "mk_live_abc").fetch(ARGS);
    expect(envelope.status).toBe("payment_unknown");
    expect(envelope.charged).toBe("maybe");
    expect(seen.auth).toBe("Bearer mk_live_abc");
    expect(JSON.parse(seen.body!)).toEqual(ARGS);
  });

  it("status() works and keeps throwing 'money_status: HTTP n' on a non-2xx answer", async () => {
    const ok = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ remaining_today: "1", remaining_total: "2", per_request_limit: "1", currency: "USDC", network: "n", key_name: "k" }));
    });
    expect((await new MoneySwitchClient(ok, "k").status()).remaining_total).toBe("2");

    const denied = await serve((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "error", code: "KEY_INVALID" }));
    });
    await expect(new MoneySwitchClient(denied, "k").status()).rejects.toThrow("money_status: HTTP 401");
  });

  it("connection cut after the request was received -> error that says the outcome is UNKNOWN / may have been charged / do not retry", async () => {
    const url = await serve((req) => {
      req.resume();
      req.on("end", () => req.socket.destroy());
    });
    const err = await new MoneySwitchClient(url, "k").fetch(ARGS).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(MoneySwitchTransportError);
    expect(err.kind).toBe("unknown");
    expect(err.message).toMatch(/UNKNOWN/);
    expect(err.message).toMatch(/MAY have been charged/);
    expect(err.message).toMatch(/Do NOT retry/);
  });

  it("our own deadline: a server that never answers -> unknown outcome after about fetchMs", async () => {
    const url = await serve((req) => {
      req.resume(); // never answers
    });
    const started = Date.now();
    const err = await new MoneySwitchClient(url, "k", { fetchMs: 400 }).fetch(ARGS).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(MoneySwitchTransportError);
    expect(err.kind).toBe("unknown");
    expect(err.message).toMatch(/no complete response within 400 ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("connection refused -> says the request was NOT sent and nothing was charged", async () => {
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const err = await new MoneySwitchClient(`http://127.0.0.1:${port}`, "k").fetch(ARGS).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(MoneySwitchTransportError);
    expect(err.kind).toBe("not_sent");
    expect(err.message).toMatch(/NOT sent and nothing was charged/);
  });

  it("a non-JSON answer keeps its message and now warns the call may have been charged", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
    });
    await expect(new MoneySwitchClient(url, "k").fetch(ARGS)).rejects.toThrow(/non-JSON response \(HTTP 502\).*may have been charged/);
  });
});
