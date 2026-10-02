import type { MoneySwitchClient, FetchEnvelope } from "./moneyswitch.js";
import { findCatalogEntry, NANSEN_CATALOG } from "./catalog.js";
import { trimNansenBody } from "./trim.js";
import { explorerTxUrl } from "./explorer.js";

/**
 * Tool catalog exposed to the model.
 *
 * Design choice (per task brief §2): the Nansen endpoint catalog (names,
 * prices, param schemas) is placed in the SYSTEM PROMPT rather than behind a
 * separate `nansen_catalog` tool call. It is small (5 entries), completely
 * static for the lifetime of a run, and the model needs it *before* it can
 * plan its first tool call anyway — putting it behind a tool would force an
 * extra round trip (and an extra AGENT_MAX_STEPS budget slot) just to fetch
 * information that costs nothing to include up front. `money_status` and
 * `nansen_query` remain tools because their results are dynamic (current
 * budget; a specific paid response) and must reflect live server state.
 */
export const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "money_status",
      description: "Get this MoneyKey's remaining USDC budget (today and total) and per-request limit.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "nansen_query",
      description:
        "Buy one Nansen data endpoint from the catalog (given in the system prompt) via MoneySwitch, paying its listed price in USDC. Returns status, cost, tx hash, remaining budget, and a trimmed data summary.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            enum: NANSEN_CATALOG.map((e) => e.name),
            description: "Catalog entry name to buy.",
          },
          params: {
            type: "object",
            description: "Params matching the chosen endpoint's JSON schema from the system prompt.",
          },
        },
        required: ["endpoint", "params"],
        additionalProperties: false,
      },
    },
  },
];

const UPSTREAM_ERROR_MAX_CHARS = 300;

/** Best-effort, defensive extraction of a short human-readable message from
 * an upstream error response body (JSON error envelopes commonly use one of
 * `error`, `message`, or `detail`), falling back to the raw body or the
 * MoneySwitch-level `reason`. Always hard-capped so it can never dump a
 * large payload into the model's context. */
function trimUpstreamErrorMessage(body: string | null, reason: string | null | undefined): string | null {
  let message: string | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const candidate = parsed.error ?? parsed.message ?? parsed.detail;
      if (typeof candidate === "string") {
        message = candidate;
      } else if (candidate !== undefined) {
        message = JSON.stringify(candidate);
      } else {
        message = body;
      }
    } catch {
      message = body;
    }
  } else if (reason) {
    message = reason;
  }
  if (!message) return null;
  return message.length > UPSTREAM_ERROR_MAX_CHARS
    ? `${message.slice(0, UPSTREAM_ERROR_MAX_CHARS)}…(truncated)`
    : message;
}

export interface ToolCallOutcome {
  /** Compact JSON string returned to the model as the tool result content. */
  content: string;
  /** Structured trace event data for the terminal UX / transcript. */
  trace: Record<string, unknown>;
}

export async function runMoneyStatus(client: MoneySwitchClient): Promise<ToolCallOutcome> {
  const status = await client.status();
  return {
    content: JSON.stringify({
      remaining_today: status.remaining_today,
      remaining_total: status.remaining_total,
      per_request_limit: status.per_request_limit,
      currency: status.currency,
      network: status.network,
    }),
    trace: { tool: "money_status", ...status },
  };
}

export async function runNansenQuery(
  client: MoneySwitchClient,
  args: { endpoint?: unknown; params?: unknown }
): Promise<ToolCallOutcome> {
  const endpointName = typeof args.endpoint === "string" ? args.endpoint : "";
  const entry = findCatalogEntry(endpointName);
  if (!entry) {
    const msg = `Unknown endpoint "${endpointName}". Valid endpoints: ${NANSEN_CATALOG.map((e) => e.name).join(", ")}.`;
    return { content: JSON.stringify({ error: msg }), trace: { tool: "nansen_query", endpoint: endpointName, error: msg } };
  }

  const params = args.params && typeof args.params === "object" ? (args.params as Record<string, unknown>) : {};
  // Only pass through keys declared in the endpoint's own schema, never
  // whatever else the model may have hallucinated into `params`.
  const allowedKeys = Object.keys(entry.params_schema.properties);
  const body: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (params[key] !== undefined) body[key] = params[key];
  }

  let envelope: FetchEnvelope;
  try {
    envelope = await client.fetch({
      url: entry.path,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      max_price: entry.price_usd,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: JSON.stringify({ error: `nansen_query transport error: ${msg}` }),
      trace: { tool: "nansen_query", endpoint: endpointName, error: msg },
    };
  }

  const summary = trimNansenBody(envelope.body);
  const txHash = envelope.payment?.tx_hash ?? null;

  // A payment was attempted (either the seller answered our EIP-3009
  // authorization with a non-402, non-"settled" response, or its
  // facilitator rejected it outright) but no on-chain settlement happened.
  // Either way the signed authorization is still HELD, not spent: it stays
  // valid until it expires (~5 min) and the on-chain reconcile loop then
  // releases it if the seller never settles. This must never be reported as
  // money spent.
  const httpStatus = envelope.http_status ?? null;
  const wasHeldNotSpent =
    envelope.code === "PAYMENT_REJECTED" ||
    (envelope.payment == null && httpStatus != null && httpStatus >= 400 && httpStatus !== 402);

  let heldNotSpentNote: string | null = null;
  if (wasHeldNotSpent) {
    const upstreamMessage = trimUpstreamErrorMessage(envelope.body, envelope.reason);
    heldNotSpentNote =
      "NOT charged on-chain (no settlement). The amount is only HELD (reserved) until the " +
      "signed authorization expires (~5 min), then auto-released by on-chain reconciliation. " +
      "Do not report it as spent." +
      (upstreamMessage ? ` Upstream error: ${upstreamMessage}` : "");
  }

  const result = {
    endpoint: endpointName,
    status: envelope.status,
    code: envelope.code,
    // "yes" | "no" | "maybe": whether this call cost money. "maybe" (status payment_unknown,
    // PAYMENT_REJECTED, ...) means a payment was signed and its outcome is unknown: never retry blindly.
    charged: envelope.charged ?? null,
    reason: envelope.reason ?? null,
    http_status: httpStatus,
    price_usd: entry.price_usd,
    paid: envelope.payment
      ? {
          amount: envelope.payment.amount,
          tx_hash: txHash,
          explorer_url: txHash ? explorerTxUrl(txHash, envelope.payment.network) : null,
          network: envelope.payment.network,
          mock: envelope.payment.mock,
        }
      : null,
    held_not_spent: heldNotSpentNote,
    remaining_today: envelope.remaining_today,
    remaining_total: envelope.remaining_total,
    data: envelope.status === "ok" ? summary : undefined,
  };

  return {
    content: JSON.stringify(result),
    trace: { tool: "nansen_query", ...result },
  };
}
