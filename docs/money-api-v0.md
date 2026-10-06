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
keys, managing the wallet and approvals); every route, including those, is
listed in `apps/server/test/unit/route-inventory.test.ts` (SPEC.md §9).

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
  "total_budget": "10",
  "network_mode": "testnet",
  "networks": ["eip155:10143", "eip155:84532"]
}
```

All amount fields are decimal USDC strings (e.g. `"0.29"`), never floats
internally. `key_name` may be `null` if the key was created without a name.

`network_mode` (v0.7.2) is the kind of chain this key pays on: `"testnet"`
(test tokens, no value) or `"mainnet"` (real USDC), fixed when the key was
issued; `null` for a key with no type anywhere in its chain (issued before
v0.7.2). `network_mode` is the key's **effective** type: its own, else the first
one set on an ancestor. `networks` lists the CAIP-2 ids of the chains the key
can pay on now (the instance's enabled chains of that kind, in
`MONEYSWITCH_NETWORKS` order; for `null`: every enabled chain where the instance
enables one kind only, the enabled testnets where it enables both). `network`
is the instance's default chain when it is among them, else the first of them,
and **`null` when the key has no payable chain on this instance** (for example
a mainnet key where only testnets are enabled now, or a chain whose levels have
different types: then `networks` is `[]` too). See "Network type of a key"
below.

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
and wallet. This is the one call an agent makes to pay.

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
  `status: "approval_required"` and has since been approved by the
  administrator in the Dashboard (or through the admin API). Only for an
  approval of a price (`kind` `"payment"`): after a new host was approved
  (`kind` `"host"`) the request is simply repeated as it was, and an
  `approval_id` that names this key's own host approval is ignored, not an error; any other id is judged as a payment approval id.

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
| `approval_required` | Either the price is between the approval threshold and the per-request limit (the approval has `kind` `"payment"`), or the URL is http(s) and its host is not in a root key's `allowed_hosts` (`kind` `"host"`; nothing has been sent to that host, and no DNS look was made). `approval_id` and `approve_url` (`{MONEYSWITCH_PUBLIC_URL}/approvals?id=…`, or the address the server itself listens on when that is not set; never the request's Host header) are set. Give the link to the person who gave you this key: it carries no token and opens without a login, and they approve with the key's PIN (or the administrator approves); you never ask for, keep or send a PIN, and never call the approve or deny routes yourself (see "Who approves" below). Poll `GET /v1/approvals/:id` about every 15 s. Once a `payment` approval is approved, retry the same request with that `approval_id`. Approving a `host` approval adds the host to the key's `allowed_hosts` for good, so retry the same request as it was, without an `approval_id` (one that is sent is ignored); the price is then checked as usual, and if it is over the approval threshold the retry answers `approval_required` once more, with a new `payment` approval. |
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
| `RATE_LIMITED` | Exceeded `max_payments_per_minute`; or the key already has 5 unexpired pending `host` approvals and this request names a sixth new host (`charged` is `no`, `limit_scope` is `"self"` with the key's `limit_key_prefix`; asking again for a host that is already waiting returns its `approval_id` instead) |
| `HOST_NOT_ALLOWED` | The URL is not http(s); or the key is a child key (a child's hosts are bound by its parent's list) and the host is not in it; or the host is a literal address that is not public unicast (IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; IPv6 `::/96` (which holds `::` and `::1`), `100::/64`, `2001::/32` (Teredo), `2001:db8::/32`, `3fff::/20`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, all of `64:ff9b:1::/48`, and an IPv4 inside `::ffff:0:0/96`, `::ffff:0:0:0/96`, `64:ff9b::/96` or `2002::/16` judged by the IPv4 rules) or `localhost` / `*.localhost`, and the key does not list it explicitly as `host:port`. No approval is made for any of these. Any other http(s) host that a root key does not list is not refused: it answers `approval_required` first |
| `SSRF_BLOCKED` | Target resolves to MoneySwitch's own listening address |
| `UNSUPPORTED_PAYMENT` | No offered payment requirement is one this key can pay: nothing matches the scheme (EIP-3009), asset and an enabled chain **of the key's kind**. A testnet key refuses a seller that accepts only mainnets, and a mainnet key one that accepts only testnets (the answer's `reason` says which kind the key pays on and the chains). Nothing was read, reserved or signed, `charged` is `no` |
| `PRICE_INVALID` | The seller quoted a price that is not a positive whole number of atomic USDC units (zero, negative, fractional or not a number); nothing was reserved or signed, `charged` is `no` |
| `INSUFFICIENT_FUNDS` | The wallet does not hold enough USDC on any chain this seller accepts (checked on each chain in `MONEYSWITCH_NETWORKS` order): ask a person to top it up, do not retry before that. The balance is cached for at most 15 s, so after a top-up wait a moment, then retry. Nothing was reserved or signed, `charged` is `no` |
| `PER_REQUEST_LIMIT_EXCEEDED` | Price exceeds the key's `per_request_limit` |
| `MAX_PRICE_EXCEEDED` | Price exceeds the request's `max_price` |
| `DAILY_BUDGET_EXCEEDED` | Would exceed the key's remaining daily budget |
| `TOTAL_BUDGET_EXCEEDED` | Would exceed the key's remaining total budget |
| `APPROVAL_REQUIRED` | Price is between the approval threshold and the per-request limit, or the host is not in a root key's `allowed_hosts` (the approval's `kind` says which: `"payment"` or `"host"`) |
| `APPROVAL_INVALID` | `approval_id` of a payment approval given but not valid (wrong key/url/method/body, expired, already used, or not yet approved; also when the seller no longer offers the chain and asset the approval was given for — a resend pays only on that chain) |
| `WALLET_LOCKED` | The server's wallet is locked; cannot sign |
| `PAYMENT_FAILED` | Payment definitively failed |
| `PAYMENT_REJECTED` | Seller answered 402 again after we signed and sent payment (its facilitator rejected it); reservation kept `unknown`, held until the signed authorization expires, then auto-released |
| `UPSTREAM_ERROR` | Unexpected error reaching the priced resource |
| `FORBIDDEN` | Malformed request (e.g. invalid `url`) |

Known limit of the chain choice: two payments made at the same moment can pick the same chain, because nothing is held back per chain for a payment that is still in flight; each looks only at the balance the chain shows when it is read.

## Child keys (back end kept, no UI)

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
approval (still decided by the administrator, or by the root key's PIN: see "Who approves" below).

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

### Who approves: the approval PIN (v0.7.4, SPEC.md §3)

A key cannot approve its own request (the AI holds the same key), so each
**root** key has a 4-6 digit **approval PIN** (the "confirmation code") for the
person who holds the key. It is not in the skill text; the AI never has it.

- `POST /v1/keys` (admin) takes `approval_pin`: a string of 4 to 6 ASCII
  digits. Left out (or `null`) a random 4-digit one is made (never a weak one).
  Anything else (a number, 3 or 7 digits, letters): `400 { "error": "APPROVAL_PIN_INVALID" }`;
  a PIN that is too easy to guess (all digits the same, a straight run with no
  wrap such as 1234 / 4321 / 0123 / 654321, or one of the most common 4-digit
  PINs such as 2580, 1357, 2468, 1212, 1004, 2000, 6969): `400 { "error":
  "APPROVAL_PIN_WEAK", "message" }`. No key is created in either case. The answer carries `approval_pin` (the plaintext,
  shown only here). Only a salted scrypt hash (`scrypt$<salt>$<hash>`) is stored.
- `POST /v1/keys/:id/approval-pin` (admin; body `{ "approval_pin"? }`, a random
  4-digit one when left out) sets or replaces the PIN of a root key, answers
  `{ id, approval_pin }` (`Cache-Control: no-store`) and sets the failure
  counter back to 0, so it also unlocks. `404` unknown id,
  `400 APPROVAL_PIN_INVALID`, `400 APPROVAL_PIN_WEAK` (as above; nothing changes, the old
  PIN and its count stay), `400 APPROVAL_PIN_CHILD_KEY` (a child key has no PIN
  of its own: its requests use its root key's). Audit row `key.approval_pin_set`
  (never the PIN). It is the only way to give a key issued before v0.7.4 a PIN
  (theirs is `NULL`: only the administrator can approve for them).
  `POST /v1/keys/:id/rotate` does **not** change the PIN.
- `POST /v1/keys/children` never creates a PIN and ignores an `approval_pin`
  in the body; its answers never mention one.
- `GET /v1/keys` and the tree rows (admin) carry `approval_pin_state`:
  `"set"`, `"none"` (no PIN) or `"locked"` for a root key, `null` for a child; and
  `approval_pin_failures`: the wrong PINs that root key's PIN has had since it was
  last set (`null` for a child).
- `GET /v1/approvals?id=<approval id>` needs **no login**: it answers
  `{ "approval": { id, key_name, url, method, kind, host?, network,
  network_kind, network_label, asset, pay_to, amount, status, pin_state,
  pin_failures, expires_at, decided_at, created_at } }` for that one request (no
  key id, nothing else; `pin_state` and `pin_failures` are the PIN state and the
  wrong-try count of its root key's PIN), `404` for an
  unknown id. Without `id` the route is the administrator's list, as before.
  The approval link `/approvals?id=…` opens this way.
- `POST /v1/approvals/:id/approve` and `…/deny` take the administrator
  (`Authorization: Bearer ms_admin_…`, no body) **or** the person who holds the
  key: **no** `Authorization` header and `{ "pin": "1234" }` in the body. The PIN
  is the one of the root key of the request's key. Any `Authorization` that is
  not the administrator's (a MoneyKey, a stale token) is `403 FORBIDDEN`
  whatever the body says: a key can never approve. A request that does not
  exist is `404`; one that is not pending any more (decided or expired) is
  `400 APPROVAL_NOT_PENDING`; neither costs a try. Refusals:
  `400 APPROVAL_PIN_INVALID` (not 4-6 digits; not counted),
  `403 APPROVAL_PIN_WRONG` (with `attempts_left`), `403 APPROVAL_PIN_LOCKED`,
  `403 APPROVAL_PIN_NOT_SET` (the root key has none) and
  `403 APPROVAL_KEY_NOT_ACTIVE` (the key or an ancestor is revoked or expired).
  **Five wrong PINs lock the root key's PIN, counted cumulatively since the PIN
  was last set**: from then on every PIN, the right one too, is
  `APPROVAL_PIN_LOCKED` until the administrator sets a PIN. A right PIN does not
  reset the count; only setting a PIN does. The count is one atomic SQL
  increment inside the transaction that checks it. The administrator is never locked out. The
  audit row names who decided: `admin`, or `pin:<root key id>` (also on
  `key.allow_host`); each counted wrong PIN is `approval.pin_wrong` (actor
  `anonymous`). The rules for a new host (one DNS look, root keys only, the host
  is appended) are the same for both.
- The limits (per-request limit, daily and total budget) are not approvable by
  anyone: over one the answer is `denied`, with no approval to give.

## Network type of a key (v0.7.2)

Mainnets and testnets can be enabled together on one server and one wallet
(`MONEYSWITCH_NETWORKS`). Every key is a **testnet key** or a **mainnet key**:

- `network_mode`: `"testnet"` | `"mainnet"` | `null`. `null` = a key issued
  before v0.7.2, with no type: on an instance that enables one kind only it
  keeps paying on every enabled chain, as before; on an instance that enables
  **both kinds it pays on the testnets only** (adding a mainnet never lets an
  old key spend real money). The type of a key is the first one set from the key
  up through its ancestors (a key without one follows its parent); if two
  levels have different types the key pays on no chain at all. It is shown
  by `GET /v1/status`, the admin `GET /v1/keys` rows (with `networks`, the
  chains the key can pay on now), the `POST /v1/keys` and
  `POST /v1/keys/children` answers, and the `POST /v1/keys/:id/rotate` answer.
  It is written when the key is issued and **cannot be changed**: there is no
  route that changes it. To change it, revoke the key and issue a new one.
- `POST /v1/keys` (admin) takes `network_mode`. Left out (or `null`): the one
  kind the instance enables, or, when it enables both kinds,
  `400 { "error": "NETWORK_MODE_REQUIRED" }`. A kind the instance does not
  enable: `400 NETWORK_MODE_NOT_ENABLED`. Anything but `"testnet"` or
  `"mainnet"`: `400 NETWORK_MODE_INVALID`. No key is created in these cases.
- `POST /v1/keys/children` (a child key): the child always has its parent's
  effective `network_mode` (with no type anywhere in the parent's chain, none).
  A `network_mode` in the body is accepted only if it equals that;
  otherwise `400 INVALID_REQUEST` with `"field": "network_mode"` and
  `"parent_value"`.
- `POST /v1/fetch`: the chains a payment may use are the instance's enabled
  chains of the key's kind (for `null`: see above). The choice by
  balance, `PRICE_INVALID`, the limits and the approvals all work on that list.
  A seller that accepts only the other kind: `denied` /
  `UNSUPPORTED_PAYMENT`, `charged: "no"`, nothing signed or reserved; the
  envelope's `reason` says which kind the key pays on (also for a key with no
  type on an instance that enables both kinds, and for a chain whose types
  disagree).
- The admin `GET /v1/admin/usage` payments and `GET /v1/approvals` rows carry
  `network_kind` (`"mainnet"` | `"testnet"`, `null` for a chain the server does
  not know and for a host approval), taken from the chain table, so a row on a
  chain that is switched off now keeps its kind.

## Handing a key to an AI: the skill (`packages/skill`)

The primary way to connect an agent is a paste-able text block (a `SKILL.md`
in the Agent Skills format) that carries this server's address and the agent's
own MoneyKey. The Dashboard builds it ("Give this to your AI"); these endpoints
support it.

| Endpoint | Auth | |
|---|---|---|
| `GET /skill.md` | none | The generic skill (never contains a key), `text/markdown; charset=utf-8`. Base URL = `MONEYSWITCH_PUBLIC_URL` when set, else the address the server itself listens on (never the request's Host header; if neither forms a plain http(s) origin the skill is server-agnostic and reads `MONEY_API_BASE` / `MONEY_API_KEY`). |
| `GET /v1/approvals/:id` | MoneyKey | After `/v1/fetch` answered `approval_required`: the key's own approval, `{ "id", "status": "pending"\|"approved"\|"denied"\|"expired"\|"used", "kind": "payment"\|"host", "amount", "currency": "USDC", "url", "method", "expires_at" }` (`kind` `"host"` = the host is not in the key's list yet: `amount` is `"0"`, there is no price until the seller quotes, `status` stays `approved` once approved, and the row also has `"host"`: the `host:port` that approving it lists, see below; a `payment` approval has no `host`). Another key's id and unknown ids both answer `404 { "status": "error", "code": "APPROVAL_NOT_FOUND" }`. Poll about every 15 s; an approval lives 10 minutes. |
| `POST /v1/approvals/:id/approve` | admin, or the key's PIN | Approves a pending approval; the administrator sends no body, the person who holds the key sends `{ "pin": "…" }` and no `Authorization` (see "Who approves" above); `…/deny` is the same. For `kind` `"payment"` that is all it does. For `kind` `"host"` it first looks the host up in DNS once (3 s limit), then, in one transaction, sets the approval to `approved`, appends the request's `host:port` (lower-case, port explicit, one trailing dot dropped) to the key's `allowed_hosts` if it is not listed yet (entries and requests are compared lower-case with one trailing dot dropped, so an entry `example.com.:443` lists `example.com`; approving means listing it permanently), and writes an audit row `key.allow_host` `{ keyId, host, approvalId }`. Two refusals leave the approval pending, so that approving again retries it: `400 { "error": "ALLOW_HOST_PRIVATE_HOST", "message" }` (the host is, or any of its DNS answers is, a private / loopback / special-use address or an address of one of this machine's own network interfaces) and `400 { "error": "ALLOW_HOST_UNRESOLVED", "message" }` (the lookup failed, answered nothing or took longer than 3 s; nothing was added). Every other `400` changes nothing either, and approving again will not help: `ALLOW_HOST_CHILD_KEY` (defensive: `/v1/fetch` never creates a host approval for a child key; only a root key's list can be widened), `ALLOW_HOST_KEY_NOT_ACTIVE` (the key is revoked or expired), and `APPROVAL_NOT_PENDING` (already decided or expired, or no approval with that id). `GET /v1/approvals` (admin list) rows carry `kind` too, and a `host` row carries `host` as well: the `host:port` approving it will list, worked out by the server (with the same rules as approving), which is what the Dashboard shows. Known limit: when the DNS look of an approval runs over 3 s it is given up on, but the lookup underneath is not cancelled, so an administrator who approves several unresponsive names in a row can keep resolver threads busy for a while. |
| `POST /v1/keys/:id/rotate` | admin | Only a hash of a key is stored, so a lost secret cannot be shown again. This issues a new secret for the same key id: budgets, usage history, approvals, child keys and settings are kept, the old secret stops working immediately (a request that authenticated with it just before and is still waiting for the seller is refused with `KEY_INVALID` before anything is reserved or signed), an audit row `key.rotate` (key prefixes only) is written. Returns `{ id, key, name, key_prefix, parent_id, depth, network_mode }`; `key` (the new plaintext) is shown only here. `404` unknown id, `409 KEY_REVOKED` for a revoked key (rotating never revives a key). |

## License

This document is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
