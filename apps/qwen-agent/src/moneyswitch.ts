/** Thin client for the MoneySwitch agent API (apps/server/src/routes/agent.ts). */

export interface FetchEnvelope {
  status: "ok" | "denied" | "approval_required" | "payment_failed" | "error";
  code: string | null;
  http_status: number | null;
  headers: Record<string, string>;
  body: string | null;
  payment: { amount: string; tx_hash: string | null; network: string; mock: boolean } | null;
  approval_id: string | null;
  reason?: string | null;
  reserved_until_expiry?: boolean;
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

export class MoneySwitchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly moneyKey: string
  ) {}

  async status(): Promise<StatusResponse> {
    const res = await fetch(`${this.baseUrl}/v1/status`, {
      headers: { authorization: `Bearer ${this.moneyKey}` },
    });
    const json = (await res.json()) as StatusResponse;
    if (!res.ok) {
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
    const res = await fetch(`${this.baseUrl}/v1/fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.moneyKey}`,
      },
      body: JSON.stringify(args),
    });
    const json = (await res.json().catch(() => null)) as FetchEnvelope | null;
    if (!json) {
      throw new Error(`nansen_query: server returned non-JSON response (HTTP ${res.status})`);
    }
    return json;
  }
}
