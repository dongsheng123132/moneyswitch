<!--
Copyright (c) MoneySwitch contributors.
Licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/).
This document describes the HTTP API a `mk_live_…` MoneyKey can call. It is
kept in sync with the implementation in apps/server/src/routes/*.ts; the
code is the source of truth if this ever drifts.
-->

# MoneySwitch Money API — MoneyKey-facing surface (v0)

This is the public HTTP API a **MoneyKey** (`mk_live_…`, `Authorization:
Bearer mk_live_...`) can call against a running MoneySwitch server. It does
not cover the admin API (`ms_admin_…`-authenticated routes for creating
keys, managing channels/wallet/approvals) — see `SPEC.md` §6 and
`SPEC-v0.2.md` §1 for those.

Base URL is wherever you run `apps/server` (default `http://127.0.0.1:4020`).

## Authentication

All routes below require `Authorization: Bearer mk_live_xxx`. An admin
token (`ms_admin_…`) is rejected on these routes.

- `/v1/status`, `/v1/history`, `/v1/fetch` return `{ status: 401, code:
  "KEY_INVALID" }`-shaped errors on auth failure (see below).
- `/v1/models`, `/v1/chat/completions`, `/v1/dashboard/billing/*` return
  OpenAI-error-shaped bodies on auth failure instead (see "OpenAI-compatible
  error format" below), since these routes are meant to be called by
  unmodified OpenAI-SDK-compatible clients.

## `GET /v1/status`

Remaining budget and key metadata for the authenticated MoneyKey.

**Response 200:**

```json
{
  "remaining_today": "0.29",
  "remaining_total": "9.71",
  "per_request_limit": "1",
  "currency": "USDC",
  "network": "eip155:10143",
  "key_name": "employee-1",
  "key_prefix": "mk_live_ab12",
  "daily_budget": "0.30",
  "total_budget": "10"
}
```

All amount fields are decimal USDC strings (e.g. `"0.29"`), never floats
internally. `key_name` may be `null` if the key was created without a name.

## `GET /v1/history?limit=20`

Recent payments made by this MoneyKey, most recent first.

**Query params:** `limit` (optional, integer, default 20).

**Response 200:**

```json
{
  "history": [
    {
      "id": 42,
      "url": "http://127.0.0.1:4021/premium-report",
      "method": "GET",
      "network": "eip155:10143",
      "amount": "0.01",
      "status": "settled",
      "tx_hash": "0x...",
      "error_code": null,
      "created_at": "2026-09-25T12:00:00.000Z",
      "kind": "fetch",
      "model": null,
      "prompt_tokens": null,
      "completion_tokens": null
    }
  ]
}
```

`status` is one of `reserved | settled | failed | unknown`. `kind` is
`fetch` or `chat` (chat rows come from `/v1/chat/completions` and populate
`model`/`prompt_tokens`/`completion_tokens`).

## `POST /v1/fetch`

Fetches an x402-priced (or free) URL through MoneySwitch's policy engine
and wallet. This is the primitive both the MCP `paid_fetch` tool and the
`connect`/dashboard "Playground" ultimately call.

**Request body:**

```json
{
  "url": "http://127.0.0.1:4021/premium-report",
  "method": "GET",
  "headers": { "X-Example": "..." },
  "body": null,
  "max_price": "0.05",
  "approval_id": null
}
```

Only `url` is required; `method` defaults to `GET`.

- `max_price` (optional decimal USDC string): abort with
  `MAX_PRICE_EXCEEDED` if the resource's price exceeds this, even if it's
  within the key's normal per-request limit.
- `approval_id` (optional): an id previously returned as `approval_id` when
  a prior identical call (same `url`/`method`/request body) came back with
  `status: "approval_required"` and has since been approved via the admin
  API or Dashboard.

**Response 200** (always 200 at the HTTP layer; policy outcomes are
communicated in the `status`/`code` fields, not the HTTP status code):

```json
{
  "status": "ok",
  "code": null,
  "http_status": 200,
  "headers": { "content-type": "application/json" },
  "body": "...",
  "payment": {
    "amount": "0.01",
    "tx_hash": "0x...",
    "network": "eip155:10143",
    "mock": false
  },
  "approval_id": null,
  "remaining_today": "0.98",
  "remaining_total": "4.98"
}
```

`status` is one of:

| `status` | Meaning |
|---|---|
| `ok` | Request succeeded (payment made if the resource was priced; `payment` is `null` for free resources). |
| `denied` | Policy rejected the request before any payment attempt; see `code`. |
| `approval_required` | Price is between the approval threshold and the per-request limit; `approval_id` is set. Retry the same request with that `approval_id` once approved. |
| `payment_failed` | Payment was attempted and definitively failed (signature/facilitator rejection); any reservation was released. |
| `error` | An unexpected error (e.g. upstream unreachable, wallet locked). |

`payment.mock: true` only appears when the server is running against the
offline mock-facilitator (T2 tests / `pnpm demo:local`); a real settlement
against the live Monad testnet facilitator never sets it.

### Error codes (`code` field, and HTTP status for `/v1/models` /
`/v1/chat/completions`, which surface the same codes as OpenAI-shaped
errors)

| Code | Meaning | OpenAI-gateway HTTP status |
|---|---|---|
| `KEY_INVALID` | Bearer token missing, malformed, or not a known key | 401 |
| `KEY_REVOKED` | Key exists but has been revoked | 403 |
| `KEY_EXPIRED` | Key's `expires_at` has passed | 403 |
| `RATE_LIMITED` | Exceeded `max_payments_per_minute` | 429 |
| `HOST_NOT_ALLOWED` | Target host not in the key's `allowed_hosts` | (fetch-only; `denied`) |
| `SSRF_BLOCKED` | Target resolves to MoneySwitch's own listening address | (fetch-only; `denied`) |
| `UNSUPPORTED_PAYMENT` | No offered payment requirement matches the configured scheme/network/asset | (fetch-only; `denied`) |
| `PER_REQUEST_LIMIT_EXCEEDED` | Price exceeds the key's `per_request_limit` | 402 |
| `MAX_PRICE_EXCEEDED` | Price exceeds the request's `max_price` | 402 |
| `DAILY_BUDGET_EXCEEDED` | Would exceed the key's remaining daily budget | 402 |
| `TOTAL_BUDGET_EXCEEDED` | Would exceed the key's remaining total budget | 402 |
| `APPROVAL_REQUIRED` | Price is between the approval threshold and the per-request limit | 409 |
| `APPROVAL_INVALID` | `approval_id` given but not valid (wrong key/url/method/body, expired, already used, or not yet approved) | (fetch-only; `denied`) |
| `WALLET_LOCKED` | The server's wallet is locked; cannot sign | (fetch-only; `error`) |
| `PAYMENT_FAILED` | Payment definitively failed | (fetch-only; `payment_failed`) |
| `UPSTREAM_ERROR` | Unexpected error reaching the priced resource / channel | (fetch-only; `error`) |
| `FORBIDDEN` | Malformed request (e.g. invalid `url`) | (fetch-only; `error`) |
| `model_not_found` | `/v1/chat/completions`: no enabled channel serves the requested `model` | 404 |
| `model_not_allowed` | `/v1/chat/completions` or `/v1/models`: key's `allowed_models` doesn't include this model | 403 |

## `GET /v1/models`

OpenAI-compatible model list, filtered to the key's `allowed_models` (all
enabled-channel models if `allowed_models` is `null`).

**Response 200:**

```json
{
  "object": "list",
  "data": [
    { "id": "moneyswitch-demo-chat", "object": "model", "created": 0, "owned_by": "moneyswitch" }
  ]
}
```

## `POST /v1/chat/completions`

OpenAI Chat Completions-compatible, x402-metered. Set `Base URL =
<server>/v1`, `API Key = mk_live_xxx` in any OpenAI-SDK-compatible client
and call this route with the standard `{ model, messages, stream? }` body
— no MoneySwitch-specific client code required.

Behavior:

1. Same key checks as `/v1/fetch` (enabled, not expired, rate limit), plus
   model resolution: `model` must be served by an enabled Channel and
   allowed for this key (see error codes above).
2. The upstream (Channel) call is always made non-streaming
   (`stream: false`) regardless of what the client asked for.
3. If the client requested `stream: true`, MoneySwitch re-emits the single
   upstream response as a two-chunk Server-Sent-Events stream (a
   `chat.completion.chunk` carrying the full content, then a chunk with
   `finish_reason: "stop"`, then `data: [DONE]`) rather than proxying a
   real token-by-token stream from the upstream.
4. On success, the JSON response is the upstream's OpenAI-shaped response
   with an added `moneyswitch` object:

   ```json
   {
     "id": "chatcmpl-...",
     "object": "chat.completion",
     "choices": [ ... ],
     "usage": { "prompt_tokens": 12, "completion_tokens": 34 },
     "moneyswitch": {
       "cost": "0.01",
       "currency": "USDC",
       "tx_hash": "0x...",
       "network": "eip155:10143",
       "remaining_today": "0.29"
     }
   }
   ```

   and response headers `X-MoneySwitch-Cost: 0.01`, `X-MoneySwitch-Tx:
   0x...` (headers are set even in streaming mode, where the body carries
   no `moneyswitch` field).

### OpenAI-compatible error format

Errors from `/v1/models`, `/v1/chat/completions`, and the billing endpoints
use the standard OpenAI error envelope:

```json
{
  "error": {
    "message": "This MoneyKey's daily budget is exhausted",
    "type": "moneyswitch_policy",
    "code": "DAILY_BUDGET_EXCEEDED",
    "approval_id": "..."
  }
}
```

`approval_id` is only present for `APPROVAL_REQUIRED`. See the error-code
table above for the HTTP status used for each `code`.

## `GET /v1/dashboard/billing/subscription`

Legacy OpenAI/NewAPI-style billing endpoint many clients probe on startup.

**Response 200:**

```json
{
  "object": "billing_subscription",
  "has_payment_method": true,
  "soft_limit_usd": 10,
  "hard_limit_usd": 10,
  "system_hard_limit_usd": 10,
  "access_until": 0
}
```

`soft_limit_usd`/`hard_limit_usd`/`system_hard_limit_usd` all mirror the
key's `total_budget` (in USD, since USDC is treated 1:1 with USD here).
`access_until` is the key's `expires_at` as a Unix timestamp in seconds, or
`0` if the key never expires.

## `GET /v1/dashboard/billing/usage`

**Response 200:**

```json
{
  "object": "list",
  "total_usage": 129
}
```

`total_usage` is the key's total spend in **USD cents** (OpenAI's legacy
convention), i.e. `total_used_micro_usdc / 10_000`.

## License

This document is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
