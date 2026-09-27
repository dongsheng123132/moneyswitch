import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeFetchEnvelope {
  status: "ok" | "denied" | "approval_required" | "payment_failed" | "error";
  code?: string | null;
  http_status?: number | null;
  headers?: Record<string, string>;
  body?: string | null;
  payment?: { amount: string; tx_hash: string | null; network: string; mock: boolean } | null;
  approval_id?: string | null;
  reason?: string | null;
  remaining_today?: string;
  remaining_total?: string;
}

/**
 * Minimal fake of the MoneySwitch agent API (apps/server/src/routes/agent.ts):
 * GET /v1/status and POST /v1/fetch. Returns one scripted /v1/fetch envelope
 * per call, in order; status is a fixed canned response.
 */
export function startFakeMoneySwitchServer(opts: {
  status: { remaining_today: string; remaining_total: string; per_request_limit: string; currency: string; network: string; key_name: string };
  fetchEnvelopes: FakeFetchEnvelope[];
}) {
  const requests: unknown[] = [];
  let callIndex = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(opts.status));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/fetch") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // ignore
        }
        requests.push(parsed);

        const envelope = opts.fetchEnvelopes[callIndex] ?? opts.fetchEnvelopes[opts.fetchEnvelopes.length - 1];
        callIndex++;

        const full = {
          status: envelope.status,
          code: envelope.code ?? null,
          http_status: envelope.http_status ?? null,
          headers: envelope.headers ?? {},
          body: envelope.body ?? null,
          payment: envelope.payment ?? null,
          approval_id: envelope.approval_id ?? null,
          ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
          remaining_today: envelope.remaining_today ?? "0",
          remaining_total: envelope.remaining_total ?? "0",
        };

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(full));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise<{ url: string; close: () => Promise<void>; requests: unknown[]; callCount: () => number }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(() => r())),
          requests,
          callCount: () => callIndex,
        });
      });
    }
  );
}
