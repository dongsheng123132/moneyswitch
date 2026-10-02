import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { callerDeadlineDispatcher } from "../src/caller-deadline.js";

/**
 * undici's headersTimeout / bodyTimeout (300 s by default) sit underneath any
 * deadline a caller sets. These tests shrink them to 300 ms through the global
 * dispatcher (what the real process has: the default Agent or the proxy-routing
 * one from installOutboundProxy) and prove the caller-deadline dispatcher is not
 * subject to them while still honouring the caller's own AbortSignal.
 */

const IDLE_LIMIT_MS = 300;
const SELLER_DELAY_MS = 1200;

let server: http.Server;
let base: string;
let previousGlobal: Dispatcher;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/slow-headers") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late but complete");
      }, SELLER_DELAY_MS);
      return;
    }
    if (req.url === "/slow-body") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-");
      setTimeout(() => res.end("second"), SELLER_DELAY_MS);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  previousGlobal = getGlobalDispatcher();
  setGlobalDispatcher(new Agent({ headersTimeout: IDLE_LIMIT_MS, bodyTimeout: IDLE_LIMIT_MS }));
});

afterAll(async () => {
  const current = getGlobalDispatcher();
  setGlobalDispatcher(previousGlobal);
  await current.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The undici error code behind a rejected fetch ("fetch failed" hides it in `cause`). */
function causeCode(e: unknown): string | undefined {
  return (e as { cause?: { code?: string } })?.cause?.code;
}

describe("callerDeadlineDispatcher", () => {
  it("premise: with the default dispatcher a response slower than the idle limit fails with UND_ERR_HEADERS_TIMEOUT", async () => {
    const err = await fetch(`${base}/slow-headers`).then(
      () => null,
      (e) => e
    );
    expect(err).not.toBeNull();
    expect(causeCode(err)).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("a response whose HEADERS arrive after the idle limit is delivered", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/slow-headers`, { dispatcher: callerDeadlineDispatcher() } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("late but complete");
    expect(Date.now() - started).toBeGreaterThanOrEqual(SELLER_DELAY_MS - 100);
  });

  it("premise: with the default dispatcher a body that stalls longer than the idle limit fails with UND_ERR_BODY_TIMEOUT", async () => {
    const res = await fetch(`${base}/slow-body`);
    const err = await res.text().then(
      () => null,
      (e) => e
    );
    expect(err).not.toBeNull();
    expect(causeCode(err) ?? (err as Error).name).toMatch(/UND_ERR_BODY_TIMEOUT|BodyTimeoutError|TypeError/);
  });

  it("a body that stalls for longer than the idle limit is read to the end", async () => {
    const res = await fetch(`${base}/slow-body`, { dispatcher: callerDeadlineDispatcher() } as RequestInit);
    expect(await res.text()).toBe("first-second");
  });

  it("the caller's own AbortSignal still bounds the request (the deadline stays in the caller's hands)", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const started = Date.now();
    const err = await fetch(`${base}/slow-headers`, {
      dispatcher: callerDeadlineDispatcher(),
      signal: controller.signal,
    } as RequestInit).then(
      () => null,
      (e) => e
    );
    clearTimeout(timer);
    expect((err as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(SELLER_DELAY_MS);
  });

  it("forwards to whatever the CURRENT global dispatcher is (so proxy routing keeps working), with both idle timers switched off", async () => {
    const seen: Array<Dispatcher.DispatchOptions> = [];
    const inner = new Agent();
    class Spy extends Dispatcher {
      override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        seen.push(opts);
        return inner.dispatch(opts, handler);
      }
    }
    const before = getGlobalDispatcher();
    setGlobalDispatcher(new Spy());
    try {
      const res = await fetch(`${base}/slow-headers`, { dispatcher: callerDeadlineDispatcher() } as RequestInit);
      expect(await res.text()).toBe("late but complete");
    } finally {
      setGlobalDispatcher(before);
      await inner.close();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].headersTimeout).toBe(0);
    expect(seen[0].bodyTimeout).toBe(0);
    expect(seen[0].path).toBe("/slow-headers");
  });

  it("is a shared, stateless singleton whose close()/destroy() do not touch the global dispatcher", async () => {
    const d = callerDeadlineDispatcher();
    expect(callerDeadlineDispatcher()).toBe(d);
    await d.close();
    await d.destroy();
    const res = await fetch(`${base}/slow-headers`, { dispatcher: d } as RequestInit);
    expect(res.status).toBe(200);
    await res.text();
  });
});
