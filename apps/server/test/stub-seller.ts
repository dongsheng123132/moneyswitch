import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { TESTNET } from "@moneyswitch/x402";

/**
 * A scriptable x402 seller for the "paid but no delivery" tests. Unlike the
 * demo-seller it lets a test decide, per request, exactly how the seller
 * misbehaves: never answer the unpaid probe, take longer than the deadline
 * AFTER being paid, send a settled header and then cut the body, and so on.
 * Settlement goes through the real mock-facilitator (real EIP-3009 signature
 * verification, fake 0xmock tx hash), so the payment path is the production one.
 */

export interface SellerBehavior {
  /** Delay before the 402 to the unpaid probe. `Infinity` = never answer it. */
  probeDelayMs: number;
  /** After the payment arrives: wait this long before responding. */
  paidDelayMs: number;
  /**
   * When to settle through the facilitator relative to the delay:
   *  - "before": settle immediately, then wait (the real incident: seller settles, answer is slow)
   *  - "never": do not settle at all
   */
  settle: "before" | "never";
  /** What the paid response looks like. */
  response:
    | "ok" //                    200 + PAYMENT-RESPONSE + full body
    | "ok-no-settle-header" //    200 + full body, no PAYMENT-RESPONSE header
    | "headers-then-destroy" //   200 + PAYMENT-RESPONSE + partial body, then the connection is cut
    | "headers-then-stall" //     200 + PAYMENT-RESPONSE + partial body, then silence
    | "reject-402" //             answer the PAID request with 402 again (facilitator declined it)
    | "destroy-before-headers"; // cut the connection after settling, before any response byte
  /** Answer unpaid requests with 200 directly (a free resource, no payment involved). */
  free: boolean;
  /** Price in atomic USDC (6 decimals). Default 10000 = 0.01 USDC. */
  amount: string;
}

export const DEFAULT_BEHAVIOR: SellerBehavior = {
  probeDelayMs: 0,
  paidDelayMs: 0,
  settle: "before",
  response: "ok",
  free: false,
  amount: "10000",
};

export interface SellerRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  paid: boolean;
}

export interface StubSeller {
  url: string;
  port: number;
  requests: SellerRequest[];
  /** Number of settle calls the seller made to the facilitator. */
  settleCalls: () => number;
  setBehavior: (b: Partial<SellerBehavior>) => void;
  reset: () => void;
  close: () => Promise<void>;
}

/** Listens on an ephemeral port (parallel test files and other sessions never collide). */
export async function startStubSeller(opts: { facilitatorUrl: string; payTo: string }): Promise<StubSeller> {
  let behavior: SellerBehavior = { ...DEFAULT_BEHAVIOR };
  const requests: SellerRequest[] = [];
  let settles = 0;
  const timers = new Set<NodeJS.Timeout>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void handle(req, res, Buffer.concat(chunks).toString("utf8")).catch(() => {
        try {
          res.destroy();
        } catch {
          // already gone
        }
      });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const b = behavior;
    const signatureHeader = req.headers["payment-signature"] ?? req.headers["x-payment"];
    const paid = typeof signatureHeader === "string";
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, paid });

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url}`;
    if (!paid && b.free) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ free: true, echo: body, contentType: req.headers["content-type"] ?? null }));
      return;
    }
    const requirements = (error: string) => ({
      x402Version: 2,
      error,
      resource: { url: base, description: "stub seller", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET.caip2,
          amount: b.amount,
          asset: TESTNET.usdcAddress,
          payTo: opts.payTo,
          maxTimeoutSeconds: 60,
          extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
        },
      ],
    });
    if (paid && b.response === "reject-402") {
      const pr = requirements("insufficient_funds");
      res.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never),
      });
      res.end(JSON.stringify(pr));
      return;
    }
    if (!paid) {
      if (!Number.isFinite(b.probeDelayMs)) return; // never answer (the client's probe deadline must fire)
      if (b.probeDelayMs > 0) await sleep(b.probeDelayMs);
      const paymentRequired = requirements("Payment required");
      res.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired as never),
      });
      res.end(JSON.stringify(paymentRequired));
      return;
    }

    // ---- paid request ----
    const payload = decodePaymentSignatureHeader(signatureHeader as string);
    let paymentResponseHeader: string | null = null;
    if (b.settle === "before") {
      const r = await fetch(`${opts.facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted }),
      });
      settles++;
      const settle = (await r.json()) as Record<string, unknown>;
      paymentResponseHeader = encodePaymentResponseHeader(settle as never);
    }
    if (b.paidDelayMs > 0) await sleep(b.paidDelayMs);
    if (res.destroyed || res.writableEnded) return; // the client gave up

    const payloadJson = JSON.stringify({ delivered: true, echo: body, contentType: req.headers["content-type"] ?? null });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (paymentResponseHeader && b.response !== "ok-no-settle-header") {
      headers["PAYMENT-RESPONSE"] = paymentResponseHeader;
    }

    switch (b.response) {
      case "ok":
      case "ok-no-settle-header":
        res.writeHead(200, headers);
        res.end(payloadJson);
        return;
      case "headers-then-destroy":
        res.writeHead(200, { ...headers, "content-length": "5000" });
        res.flushHeaders();
        res.write('{"delivered":tr', () => {
          setTimeout(() => res.socket?.destroy(), 30);
        });
        return;
      case "headers-then-stall":
        res.writeHead(200, { ...headers, "content-length": "5000" });
        res.flushHeaders();
        res.write('{"delivered":tr');
        return; // never ends
      case "destroy-before-headers":
        res.socket?.destroy();
        return;
      case "reject-402":
        return; // handled above
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    settleCalls: () => settles,
    setBehavior: (b) => {
      behavior = { ...behavior, ...b };
    },
    reset: () => {
      behavior = { ...DEFAULT_BEHAVIOR };
      requests.length = 0;
      settles = 0;
    },
    close: async () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
