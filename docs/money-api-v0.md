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
keys, managing the wallet and approvals) — see `SPEC.md` §6 for those.

Base URL is wherever you run `apps/server` (default `http://127.0.0.1:4020`).

## Authentication

All routes below require `Authorization: Bearer mk_live_xxx`. An admin
token (`ms_admin_…`) is rejected on these routes.

- `/v1/status`, `/v1/history`, `/v1/fetch` return `{ status: 401, code:
  "KEY_INVALID" }`-shaped errors on auth failure (see below).

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
      "kind": "fetch"
    }
  ]
}
```

`status` is one of `reserved | settled | failed | unknown`. `kind` is `fetch`
for every payment made now; `chat` only appears on old rows written by the
removed OpenAI-compatible gateway (they still list, as ordinary payments).

## `POST /v1/fetch`

Fetches an x402-priced (or free) URL through MoneySwitch's policy engine
and wallet. This is the one call an agent makes to pay; the Dashboard's
"Test payment" page calls the same route.

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
offline mock-facilitator (T2 tests); a real settlement
against the live Monad testnet facilitator never sets it.

### Error codes (`code` field)

| Code | Meaning |
|---|---|
| `KEY_INVALID` | Bearer token missing, malformed, or not a known key |
| `KEY_REVOKED` | Key exists but has been revoked |
| `KEY_EXPIRED` | Key's `expires_at` has passed |
| `RATE_LIMITED` | Exceeded `max_payments_per_minute` |
| `HOST_NOT_ALLOWED` | Target host not in the key's `allowed_hosts` |
| `SSRF_BLOCKED` | Target resolves to MoneySwitch's own listening address |
| `UNSUPPORTED_PAYMENT` | No offered payment requirement matches the configured scheme/network/asset |
| `PER_REQUEST_LIMIT_EXCEEDED` | Price exceeds the key's `per_request_limit` |
| `MAX_PRICE_EXCEEDED` | Price exceeds the request's `max_price` |
| `DAILY_BUDGET_EXCEEDED` | Would exceed the key's remaining daily budget |
| `TOTAL_BUDGET_EXCEEDED` | Would exceed the key's remaining total budget |
| `APPROVAL_REQUIRED` | Price is between the approval threshold and the per-request limit |
| `APPROVAL_INVALID` | `approval_id` given but not valid (wrong key/url/method/body, expired, already used, or not yet approved) |
| `WALLET_LOCKED` | The server's wallet is locked; cannot sign |
| `PAYMENT_FAILED` | Payment definitively failed |
| `PAYMENT_REJECTED` | Seller answered 402 again after we signed and sent payment (its facilitator rejected it); reservation kept `unknown`, held until the signed authorization expires, then auto-released |
| `UPSTREAM_ERROR` | Unexpected error reaching the priced resource |
| `FORBIDDEN` | Malformed request (e.g. invalid `url`) |

## Child keys (v0.4, SPEC-v0.4 §A)

A MoneyKey created by the admin with `can_delegate: true` can cut **child
keys** for its own agents; a child created with `can_delegate: true` can cut
its own children, down to `MONEYSWITCH_MAX_KEY_DEPTH` (default 3: root + 3
levels). A child can never do more than its parent:

- `per_request_limit`, `daily_budget`, `total_budget`,
  `max_payments_per_minute` ≤ the parent's;
- `allowed_hosts` ⊆ the parent's (a parent entry `host` covers any
  `host:port`; `host:port` covers only that port); omitted → inherited;
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
errors.

### `GET /v1/status` (v0.4 additions)

`remaining_today` / `remaining_total` / `per_request_limit` are now the
**effective** values (minimum over the key and its ancestors). New fields:
`used_today`, `used_total` (subtree), `remaining_today_scope`,
`remaining_total_scope` (`self|ancestor`: which level binds),
`approval_threshold` (effective), `expires_at` (effective), `depth`,
`max_depth`, `can_delegate`, `can_create_children`, `is_child`.

### `POST /v1/keys/children`

Body: `{ name, daily_budget, total_budget, per_request_limit,
approval_threshold?, allowed_hosts?, expires_at?,
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
allowed_hosts, max_payments_per_minute, expires_at,
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

## Handing a key to an AI: the skill (`packages/skill`)

The primary way to connect an agent is a paste-able text block (a `SKILL.md`
in the Agent Skills format) that carries this server's address and the agent's
own MoneyKey. The Dashboard builds it ("Give this to your AI"); these endpoints
support it.

| Endpoint | Auth | |
|---|---|---|
| `GET /skill.md` | none | The generic skill (never contains a key), `text/markdown; charset=utf-8`. Base URL = `MONEYSWITCH_PUBLIC_URL` when set, else the request origin (only if it forms a plain http(s) origin, otherwise the skill is server-agnostic and reads `MONEY_API_BASE` / `MONEY_API_KEY`). |
| `GET /v1/approvals/:id` | MoneyKey | After `/v1/fetch` answered `approval_required`: the key's own approval, `{ "id", "status": "pending"\|"approved"\|"denied"\|"expired"\|"used", "amount", "currency": "USDC", "url", "method", "expires_at" }`. Another key's id and unknown ids both answer `404 { "status": "error", "code": "APPROVAL_NOT_FOUND" }`. Poll about every 15 s; an approval lives 10 minutes. |
| `POST /v1/keys/:id/rotate` | admin | Only a hash of a key is stored, so a lost secret cannot be shown again. This issues a new secret for the same key id: budgets, usage history, approvals, child keys and settings are kept, the old secret stops working immediately (a request that authenticated with it just before and is still waiting for the seller is refused with `KEY_INVALID` before anything is reserved or signed), an audit row `key.rotate` (key prefixes only) is written. Returns `{ id, key, name, key_prefix, parent_id, depth }`; `key` (the new plaintext) is shown only here. `404` unknown id, `409 KEY_REVOKED` for a revoked key (rotating never revives a key). |

## License

This document is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
