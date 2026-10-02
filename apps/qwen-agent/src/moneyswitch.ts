import http from "node:http";
import https from "node:https";

/** Thin client for the MoneySwitch agent API (apps/server/src/routes/agent.ts). */

export interface FetchEnvelope {
  status: "ok" | "denied" | "approval_required" | "payment_failed" | "payment_unknown" | "error";
  code: string | null;
  http_status: number | null;
  headers: Record<string, string>;
  body: string | null;
  payment: { amount: string; tx_hash: string | null; network: string; mock: boolean } | null;
  approval_id: string | null;
  reason?: string | null;
  reserved_until_expiry?: boolean;
  /**
   * Whether this call cost money: "yes" a settlement was confirmed, "no" definitely nothing
   * was signed or charged, "maybe" a payment was signed and sent but the outcome is unknown
   * (never retry blindly). Absent when talking to a server older than this field.
   */
  charged?: "yes" | "no" | "maybe";
  remaining_today: string;
  remaining_total: string;
  [key: string]: unknown;
}

export interface StatusResponse {
  remaining_today: string;
  remaining_total: string;
  per_request_limit: string;
  currency: string;
  network: string;
  key_name: string;
  [key: string]: unknown;
}

/** Failures while connecting: nothing was sent, so nothing can have been charged. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL",
]);

/**
 * The HTTP exchange with MoneySwitch failed. The message is written for the
 * model that will read it as a tool result: unless the request provably never
 * left this machine, the call may have been charged and must not be retried
 * blindly.
 */
export class MoneySwitchTransportError extends Error {
  readonly kind: "not_sent" | "unknown";
  constructor(detail: string, kind: "not_sent" | "unknown") {
    super(
      kind === "not_sent"
        ? `could not reach MoneySwitch, the request was NOT sent and nothing was charged (${detail})`
        : `the connection to MoneySwitch failed after the request was sent (${detail}); the outcome is UNKNOWN: ` +
            `the call MAY have been charged. Do NOT retry blindly; the payment history shows whether it settled.`
    );
    this.name = "MoneySwitchTransportError";
    this.kind = kind;
  }
}

/** Default hard caps. /v1/fetch answers only after the whole paid exchange: server probe deadline (30 s) + paid deadline (300 s). */
export const DEFAULT_STATUS_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 600_000;

/**
 * node:http instead of the global fetch(): fetch's undici stops waiting for
 * response headers after ~300 s (UND_ERR_HEADERS_TIMEOUT), which is before a
 * slow paid call's verdict can arrive. The deadline here is explicit.
 */
function requestJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new MoneySwitchTransportError(`invalid MoneySwitch URL "${url}"`, "not_sent"));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
    if (!lib) {
      reject(new MoneySwitchTransportError(`unsupported protocol ${parsed.protocol}`, "not_sent"));
      return;
    }
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (e: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      const code = (e as { code?: string } | null)?.code;
      const detail = timedOut ? `no complete response within ${timeoutMs} ms` : e instanceof Error ? e.message : String(e);
      reject(new MoneySwitchTransportError(detail, code && NOT_SENT_CODES.has(code) ? "not_sent" : "unknown"));
    };
    const req = lib.request(
      parsed,
      {
        method,
        headers: { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let ended = false;
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          ended = true;
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", fail);
        res.on("close", () => {
          if (!ended) fail(Object.assign(new Error("connection closed before the response was complete"), { code: "ECONNRESET" }));
        });
      }
    );
    req.on("error", fail);
    timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("timeout"));
    }, timeoutMs);
    req.end(body);
  });
}

export class MoneySwitchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly moneyKey: string,
    private readonly timeouts: { statusMs?: number; fetchMs?: number } = {}
  ) {}

  async status(): Promise<StatusResponse> {
    const res = await requestJson(
      `${this.baseUrl}/v1/status`,
      "GET",
      { authorization: `Bearer ${this.moneyKey}` },
      undefined,
      this.timeouts.statusMs ?? DEFAULT_STATUS_TIMEOUT_MS
    );
    let json: StatusResponse;
    try {
      json = JSON.parse(res.text) as StatusResponse;
    } catch {
      throw new Error(`money_status: HTTP ${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`money_status: HTTP ${res.status}`);
    }
    return json;
  }

  async fetch(args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    max_price: string;
  }): Promise<FetchEnvelope> {
    const res = await requestJson(
      `${this.baseUrl}/v1/fetch`,
      "POST",
      { "content-type": "application/json", authorization: `Bearer ${this.moneyKey}` },
      JSON.stringify(args),
      this.timeouts.fetchMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    let json: FetchEnvelope | null = null;
    try {
      json = JSON.parse(res.text) as FetchEnvelope;
    } catch {
      json = null;
    }
    if (!json) {
      throw new Error(
        `nansen_query: server returned non-JSON response (HTTP ${res.status}); ` +
          `if the request reached MoneySwitch the call may have been charged, so do not retry blindly`
      );
    }
    return json;
  }
}
