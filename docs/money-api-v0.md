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
`SPEC-v0.2.md` §1 for those — except the toll booth admin routes, which are
listed with the public toll booth behaviour in
[Toll booths](#toll-booths-v05-spec-v05-2).

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
| `PAYMENT_REJECTED` | Seller answered 402 again after we signed and sent payment (its facilitator rejected it); reservation kept `unknown`, held until the signed authorization expires, then auto-released | (fetch-only; `payment_failed`) |
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

## Child keys (v0.4, SPEC-v0.4 §A)

A MoneyKey created by the admin with `can_delegate: true` can cut **child
keys** for its own agents; a child created with `can_delegate: true` can cut
its own children, down to `MONEYSWITCH_MAX_KEY_DEPTH` (default 3: root + 3
levels). A child can never do more than its parent:

- `per_request_limit`, `daily_budget`, `total_budget`,
  `max_payments_per_minute` ≤ the parent's;
- `allowed_hosts` ⊆ the parent's (a parent entry `host` covers any
  `host:port`; `host:port` covers only that port); `allowed_models` ⊆ the
  parent's effective list; omitted → inherited;
- `expires_at` ≤ the parent's effective expiry (omitted → inherited);
- `approval_threshold` ≤ the strictest threshold on the parent's chain
  (omitted → the ancestors' thresholds still apply).

At payment time the policy engine checks, **in the same SQLite transaction
that reserves the payment**, the key itself and every ancestor: enabled,
unexpired, per-request limit, daily and total budget — where a key's "used"
is the settled+reserved+unknown sum of its **whole subtree**. The first
failing level wins. Revoking/expiring any ancestor disables the whole
subtree immediately. Any ancestor's `approval_threshold` also triggers
approval (still decided by the admin).

### Error bodies carry the limiting level

Key-state and limit denials (`KEY_REVOKED`, `KEY_EXPIRED`, `RATE_LIMITED`,
`HOST_NOT_ALLOWED`, `PER_REQUEST_LIMIT_EXCEEDED`, `DAILY_BUDGET_EXCEEDED`,
`TOTAL_BUDGET_EXCEEDED`) add:

```json
{ "limit_scope": "self | ancestor", "limit_key_prefix": "mk_live_ab12" }
```

— top-level in the `/v1/fetch` envelope and in `{status:"error"}` auth
errors, inside `error` for OpenAI-shaped errors.

### `GET /v1/status` (v0.4 additions)

`remaining_today` / `remaining_total` / `per_request_limit` are now the
**effective** values (minimum over the key and its ancestors). New fields:
`used_today`, `used_total` (subtree), `remaining_today_scope`,
`remaining_total_scope` (`self|ancestor`: which level binds),
`approval_threshold` (effective), `expires_at` (effective), `depth`,
`max_depth`, `can_delegate`, `can_create_children`, `is_child`.

### `POST /v1/keys/children`

Body: `{ name, daily_budget, total_budget, per_request_limit,
approval_threshold?, allowed_hosts?, allowed_models?, expires_at?,
can_delegate?, max_payments_per_minute? }` (amounts are decimal strings;
numbers are accepted too).

- 200: the child key view (same fields as the admin `GET /v1/keys` rows) plus
  `key` — the full `mk_live_…`, returned **only here**. Audited as
  `key.child_create` with actor `key:<parentId>`.
- 400 `{ "error": "CHILD_EXCEEDS_PARENT", "code": "CHILD_EXCEEDS_PARENT",
  "message", "field": "daily_budget", "parent_value": "1" }` — `field` is the
  offending request field. `INVALID_REQUEST` (same shape) for missing /
  malformed fields.
- 403 `DELEGATION_NOT_ALLOWED` (caller has `can_delegate=false`),
  `MAX_DEPTH_EXCEEDED` (caller is at max depth, or `can_delegate:true`
  requested for a child that would sit at max depth), `CHILDREN_LIMIT_REACHED`
  (100 direct children per key, revoked ones included).
- 401 `KEY_REVOKED` / `KEY_EXPIRED` (+ `limit_scope`) if the caller or an
  ancestor is no longer active.

### `GET /v1/keys/children`

`{ "children": [ … ] }` — the caller's **direct** children, oldest first:
`id, name, key_prefix, enabled, status (active|revoked|expired|ancestor_revoked|ancestor_expired),
total_budget, daily_budget, per_request_limit, approval_threshold,
allowed_hosts, allowed_models, max_payments_per_minute, expires_at,
created_at, last_used_at, used_today, used_total (subtree), own_used_today,
own_used_total, parent_id, depth, can_delegate, created_by, children_count`.
Never the key or its hash.

### `POST /v1/keys/children/:id/revoke`

Revokes any key in the caller's subtree (child, grandchild, …) →
`{ "id", "revoked": true }`. Anything else — the caller itself, its parent,
a sibling, another tree, an unknown id — is `404 { "code": "NOT_FOUND" }`
(indistinguishable, so it cannot be used to probe for keys). Audited as
`key.child_revoke`.

### Admin additions

`POST /v1/keys` accepts `can_delegate` (default `false`); `GET /v1/keys`
rows add `parent_id, depth, can_delegate, created_by, children_count,
status, own_used_today, own_used_total` (`used_today`/`used_total` are
subtree totals); `GET /v1/admin/keys/tree` returns
`{ "tree": [ { …row, "children": [ … ] } ] }`.

## Toll booths (v0.5, SPEC-v0.5 §2)

A toll booth sells an existing HTTP API to AI agents: every call is paid in
USDC over x402 before it is forwarded. It is the **receiving** side of
MoneySwitch; the paying side is `POST /v1/fetch` above (a MoneyKey can buy
from any toll booth — on another server, or on this same server).

### Public entry: `ANY /t/{slug}/{path…}`

No MoneySwitch credential is involved: buyers pay with x402. Supported
methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. Request/response
bodies are passed through as raw bytes (max 10 MB each).

Processing, in order:

1. **Toll booth lookup.** Unknown or disabled `slug` → `404
   {"error":"TOLLBOOTH_NOT_FOUND"}`.
2. **Path normalization** (before any pricing): dot segments resolved
   (including `%2e`), repeated slashes collapsed, percent-escapes decoded
   for matching, matching is case-insensitive and ignores a trailing slash.
   The upstream receives exactly the normalized path, so the path that was
   priced is the path that is served. Encoded `/` or `\` (`%2F`, `%5C`),
   backslashes, NUL/control characters → `400 {"error":"BAD_PATH"}`.
3. **Rule match.** Rules are `METHOD` (or `ANY`) + a path pattern: an exact
   path (`/v1/chat/completions`) or a pattern with `*` (`/v1/*`, `/files/*.pdf`;
   `/v1/*` also matches `/v1`). The longest literal prefix wins; on a tie an
   exact pattern beats a wildcard, then a specific method beats `ANY`.
   `HEAD` also matches `GET` rules. No match → the toll booth's
   `default_price`; `default_price: null` → `404 {"error":"NOT_FOR_SALE"}`.
4. **Price 0** → forwarded for free (no x402 at all).
5. **Price > 0** → x402 via the official SDK (`@x402/core/server`
   `x402ResourceServer` + `HTTPFacilitatorClient` + `@x402/evm` `exact`):
   - no payment → **`402`** with the SDK's `PAYMENT-REQUIRED` header
     (`accepts[0].payTo` = the toll booth's receiving address, `amount` in
     USDC atomic units, `network` `eip155:10143`, the testnet USDC `asset`)
     and a human-readable JSON body:
     ```json
     {"error":"payment_required","message":"This API costs 0.01 USDC per call (x402)…",
      "toll_booth":"Weather API","price_usdc":"0.01","pay_to":"0xAbC…","network":"eip155:10143",
      "asset":"0x534b…43A3","description":"…","settlement":"You are only charged if the service answers with 2xx/3xx. Errors are never charged."}
     ```
     Browsers (`Accept: text/html`) get a small static page with the same facts.
   - payment present → the facilitator **verifies** it; invalid → `402` (SDK).
   - the same payment header while it is already being served or after it
     settled → `409 {"error":"PAYMENT_ALREADY_USED"}`.
6. **Forward** to `upstream_url + path + ?query` — `redirect: "manual"`
   (3xx returned as-is, `Location` inside the upstream rewritten to the
   public `/t/{slug}/…` URL), 30 s timeout (`504 UPSTREAM_TIMEOUT`), 10 MB
   response cap (`502 UPSTREAM_TOO_LARGE`), unreachable → `502
   UPSTREAM_UNREACHABLE`.
   - **Stripped from the buyer's request**: hop-by-hop headers (and any listed
     in `Connection`), `Host` (unless `forward_host_header`), `Authorization`,
     `Proxy-Authorization`, `Cookie`, all x402 headers (`PAYMENT-SIGNATURE`,
     `X-PAYMENT`, …), method-override headers, `Forwarded`/`X-Forwarded-*`/
     `X-Real-IP`, and any client-supplied `X-MoneySwitch-*`.
   - **Added for the upstream**: `X-MoneySwitch-Tollbooth: <slug>`,
     `X-MoneySwitch-Amount: <USDC, "0" for free routes>`,
     `X-MoneySwitch-Payer: <0x payer>` (paid routes; the payment is verified
     but **not yet settled** at this point), fresh `X-Forwarded-For/-Host/-Proto`.
     These headers are only trustworthy if the upstream is reachable
     exclusively through the toll booth.
7. **Settle only on success.** Upstream `2xx`/`3xx` → the SDK settles, the
   buyer gets the upstream response plus the SDK's `PAYMENT-RESPONSE`
   header, and an earnings row `settled` (with `tx_hash`) is written.
   Upstream `4xx`/`5xx`, timeout or connection error → the verified payment
   is **cancelled, never settled**; the buyer gets the upstream status/body
   (or the 502/504 above) and **is not charged**; an earnings row `failed`
   with `upstream_status` is written. If the facilitator refuses to settle
   after a successful upstream call, the buyer gets the SDK's settlement
   failure `402` instead of the content.
8. **Response to the buyer**: upstream headers minus hop-by-hop,
   `Set-Cookie`, `Content-Encoding`/`Content-Length` and any
   upstream-supplied x402 header; every `/t/*` response carries
   `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`
   (the content is served from MoneySwitch's own origin).

A buyer's own MoneySwitch sees a toll booth like any other x402 seller:

```bash
curl -s http://<buyer-server>/v1/fetch -H "Authorization: Bearer mk_live_…" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<seller-server>/t/weather/v1/today"}'
# → {"status":"ok","http_status":200,"payment":{"amount":"0.01","tx_hash":"0x…",…},…}
# upstream 500 → {"status":"ok","http_status":500,"payment":null,…}   (not settled)
```

The buyer key's `allowed_hosts` must list the seller's `host:port`. Buying
from a toll booth on the **same** server is allowed: the self-port SSRF rule
makes an exception for paths under `/t/` only (`/v1/*`, the Dashboard and
everything else on the server's own port stay blocked). On the buyer's
side, a call that reached the upstream but came back unsettled (e.g. 500) is
recorded conservatively as `unknown` (see [security notes](security.md)).

### Admin API (`Authorization: Bearer ms_admin_…`)

| Route | Purpose |
|---|---|
| `GET /v1/admin/tollbooths` | list (each with `routes`, `public_url`, `earnings_today`, `paid_calls_today`, `earnings_total`, `pay_to_is_wallet`) |
| `GET /v1/admin/tollbooths/:id` | one toll booth |
| `POST /v1/admin/tollbooths` | create: `{name, slug?, upstream_url, pay_to?, default_price: "0.01"\|"0"\|null, description?, forward_host_header?, enabled?, routes?: [{method, path_pattern, price, description?}]}`; `pay_to` defaults to this server's wallet address |
| `PATCH /v1/admin/tollbooths/:id` | same fields; `routes` replaces the whole rule list atomically; `{"enabled":false}` takes it offline |
| `DELETE /v1/admin/tollbooths/:id` | delete (its earnings history is kept) |
| `POST /v1/admin/tollbooths/:id/routes`, `PATCH`/`DELETE …/routes/:routeId` | edit single rules |
| `POST /v1/admin/tollbooths/:id/test`, `POST /v1/admin/tollbooths/test-upstream {upstream_url}` | free reachability probe (one `GET` of the upstream base URL, 5 s, no redirects, never charges) → `{ok:true,status,latency_ms,healthy}` / `{ok:false,error,message}` |
| `GET /v1/admin/earnings?range=today\|7d\|all&tollbooth=<id>` | `{total, settled_count, failed_count, by_tollbooth[], by_route[], items[]}` (items newest first, max 500; `total` = settled only) |
| `GET /v1/admin/meta` | now also `wallet_address` (default receiving address) and `public_base` (`MONEYSWITCH_PUBLIC_URL`, else the request origin) |

Validation errors are `400 {"error": CODE, "message": "…", "reason"?: …}`:
`INVALID_PAY_TO` (with `reason` `LOOKS_LIKE_MONEYKEY`, `LOOKS_LIKE_ADMIN_TOKEN`,
`LOOKS_LIKE_PRIVATE_KEY`, `LOOKS_LIKE_MNEMONIC`, `NOT_AN_ADDRESS`,
`BAD_CHECKSUM`, `ZERO_ADDRESS`, `EMPTY` — the rejected value is never echoed),
`PAY_TO_REQUIRED` (no wallet yet and no `pay_to`), `INVALID_UPSTREAM`,
`UPSTREAM_IS_SELF` (upstream resolves to this server's own port, in any
spelling), `INVALID_ROUTE`, `INVALID_PRICE`, `INVALID_NAME`, `INVALID_SLUG`;
`409 SLUG_TAKEN`. A receiving address may be sent in any case; mixed case
must match its EIP-55 checksum; it is stored and shown checksummed.

MoneyKey routes additionally answer a `0x…` address sent as a bearer token
with `401 {"code":"KEY_INVALID","hint":"LOOKS_LIKE_ADDRESS"}`.

### `moneyswitch sell`

The same toll booth as a single local process (no MoneySwitch server):
`moneyswitch sell --upstream <url> --pay-to <0x…> [--price <usdc>] [--route
"METHOD /path=<usdc>"]… [--port 4402]`. Identical rules, normalization,
forwarding and settle-on-success semantics (x402 via the official
`@x402/express` middleware). Unmatched paths are refused when `--price` is
omitted. `--pay-to` refuses MoneyKeys, admin tokens, private keys and
recovery phrases (exit code 2).

## License

This document is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
