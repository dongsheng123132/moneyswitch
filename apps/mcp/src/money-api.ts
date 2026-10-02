import http from "node:http";
import https from "node:https";

/**
 * HTTP transport of the MCP server to the MoneySwitch Money API.
 *
 * Why not the global fetch(): its undici gives up waiting for response headers
 * after ~300 s (UND_ERR_HEADERS_TIMEOUT) and the timer cannot be changed per
 * call. MoneySwitch answers POST /v1/fetch only after the whole paid exchange —
 * up to the probe deadline (30 s) plus the paid deadline (300 s) — so a fetch()
 * client can give up BEFORE the server's verdict arrives and the agent would see
 * a bare "fetch failed" for a call that may have been charged. node:http has no
 * default response timeout; the deadline here is explicit and ours.
 */

/** Codes of failures that happen while connecting: nothing was sent, so nothing can have been charged. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL",
]);

export class MoneyApiTransportError extends Error {
  /**
   * "not_sent": the request provably never reached MoneySwitch (connect-level failure).
   * "unknown": it may have reached it (reset, timeout, truncated response, ...) — the server
   * may still have processed it, and a paid call may have been charged.
   */
  readonly kind: "not_sent" | "unknown";
  readonly code: string | undefined;
  readonly timedOut: boolean;

  constructor(message: string, kind: "not_sent" | "unknown", code?: string, timedOut = false) {
    super(message);
    this.name = "MoneyApiTransportError";
    this.kind = kind;
    this.code = code;
    this.timedOut = timedOut;
  }
}

/** A positive finite number of ms, else the fallback (a timeout must not be disable-able by a typo). */
export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 2_147_483_647 ? Math.floor(n) : fallback;
}

export interface MoneyApiRequest {
  baseUrl: string;
  path: string;
  method: string;
  apiKey: string;
  body?: unknown;
  /** Hard cap for the whole exchange (request sent -> response fully read). */
  timeoutMs: number;
}

export function requestMoneyApi(req: MoneyApiRequest): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${req.baseUrl}${req.path}`);
    } catch {
      reject(new MoneyApiTransportError(`invalid MONEY_API_BASE "${req.baseUrl}"`, "not_sent", "ERR_INVALID_URL"));
      return;
    }
    const lib = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!lib) {
      reject(new MoneyApiTransportError(`unsupported protocol ${url.protocol}`, "not_sent", "ERR_INVALID_PROTOCOL"));
      return;
    }

    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (e: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      const code = (e as { code?: string } | null)?.code;
      const detail = timedOut
        ? `no complete response within ${req.timeoutMs} ms`
        : e instanceof Error
          ? e.message
          : String(e);
      reject(new MoneyApiTransportError(detail, code && NOT_SENT_CODES.has(code) ? "not_sent" : "unknown", code, timedOut));
    };

    const request = lib.request(
      url,
      {
        method: req.method,
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          "Content-Type": "application/json",
          ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
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
          let json: any = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on("error", fail);
        res.on("close", () => {
          if (!ended) fail(Object.assign(new Error("connection closed before the response was complete"), { code: "ECONNRESET" }));
        });
      }
    );
    request.on("error", fail);
    timer = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("timeout"));
    }, req.timeoutMs);
    request.end(payload);
  });
}
