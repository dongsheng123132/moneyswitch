import type { FetchLike } from "moneyswitch-connect/lib/status";

/**
 * Client for the MoneySwitch server endpoints the desktop console uses
 * (SPEC-v0.4 §A, MoneyKey auth — the caller is the parent key):
 *   GET  /v1/status
 *   POST /v1/keys/children
 *   GET  /v1/keys/children
 *   POST /v1/keys/children/:id/revoke
 * Only the MoneyKey goes to the server; model API keys never do.
 */
export interface KeyStatus {
  key_name?: string;
  key_prefix?: string;
  remaining_today?: string;
  remaining_total?: string;
  daily_budget?: string;
  total_budget?: string;
  per_request_limit?: string;
  used_today?: string;
  currency?: string;
  network?: string;
  can_delegate?: boolean;
  can_create_children?: boolean;
  depth?: number;
  max_depth?: number;
  is_child?: boolean;
  [k: string]: unknown;
}

export interface ChildKey {
  id: string;
  name: string;
  key_prefix: string;
  status?: string;
  daily_budget: string;
  total_budget: string;
  per_request_limit: string;
  used_today?: string;
  used_total?: string;
  [k: string]: unknown;
}

export class MoneyApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly body: unknown
  ) {
    super(message);
  }
}

export function normalizeServer(server: string): string {
  const s = server.trim().replace(/\/+$/, "");
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("server must be an http(s) URL");
  return s.replace(/\/v1$/, "");
}

export class MoneyApi {
  constructor(
    private readonly server: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.server}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : (e as Error).message;
      throw new MoneyApiError(0, "UNREACHABLE", `cannot reach ${this.server}: ${msg}`, null);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const b = (json ?? {}) as Record<string, unknown>;
      const code = String(b.code ?? b.error ?? `HTTP_${res.status}`);
      const message = String(b.message ?? b.error ?? `HTTP ${res.status}`);
      throw new MoneyApiError(res.status, code, message, json);
    }
    return json as T;
  }

  status(): Promise<KeyStatus> {
    return this.call<KeyStatus>("GET", "/v1/status");
  }

  createChild(input: { name: string; daily_budget: string; total_budget: string; per_request_limit: string; can_delegate?: boolean }): Promise<ChildKey & { key: string }> {
    return this.call("POST", "/v1/keys/children", { ...input, can_delegate: input.can_delegate ?? false });
  }

  async listChildren(): Promise<ChildKey[]> {
    const r = await this.call<{ children: ChildKey[] }>("GET", "/v1/keys/children");
    return r.children ?? [];
  }

  revokeChild(id: string): Promise<{ id: string; revoked: boolean }> {
    return this.call("POST", `/v1/keys/children/${encodeURIComponent(id)}/revoke`, {});
  }
}

/** Decimal USDC string helpers (2-6 dp), without floating point surprises for the values we handle. */
export function toMicros(v: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d{0,6}))?\s*$/.exec(v);
  if (!m) throw new Error(`not a USDC amount: ${v}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

export function fromMicros(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${frac.length >= 2 ? frac : frac.padEnd(2, "0")}`;
}

/**
 * Default child budgets: split what the parent can still spend today across
 * `n` agents, rounded down to the cent, never above the parent's per-request
 * limit; total = the same share of the parent's remaining total.
 */
export function suggestChildBudgets(parent: KeyStatus, n: number): { daily_budget: string; per_request_limit: string; total_budget: string } {
  const share = (v: string | undefined) => {
    if (!v) return 0n;
    const each = toMicros(v) / BigInt(Math.max(1, n));
    return (each / 10_000n) * 10_000n; // floor to cents
  };
  const daily = share(parent.remaining_today);
  const total = share(parent.remaining_total);
  const perParent = parent.per_request_limit ? toMicros(parent.per_request_limit) : daily;
  const per = [daily, perParent].reduce((a, b) => (a < b ? a : b));
  return { daily_budget: fromMicros(daily), per_request_limit: fromMicros(per), total_budget: fromMicros(total) };
}
