# MoneySwitch

**An AI spends from a capped key. Anything over the approval line waits for a human. The private key is never given to the AI.**

[Website](https://moneyswitch.dev) · [中文](README.zh-CN.md) · [Spec](SPEC.md) · [Self-hosting guide](deploy/README.zh-CN.md)

[SPEC.md](SPEC.md) is the only specification. This file says how to run it.

## Run it

Node.js 22+ and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server-pkg/dist/cli.js --data-dir ./data
```

The first start prints an administrator token and a one-time sign-in link (valid 30 minutes, single use). Open the link: it signs you in and lands on the Wallet page. Set `MONEYSWITCH_PUBLIC_URL` to the address people will reach the server at; approval links and the skill text use it (without it they name the server's own listen address, `http://127.0.0.1:4020` by default, never a request's `Host` header). Lost the administrator token? On the server itself, as the user that runs it: `moneyswitch-server reset-admin-token` (Docker: `docker compose exec server node /app/dist/cli.js reset-admin-token`; from source: `pnpm admin:reset-token -- --data-dir <dir>`); see [docs/security.md](docs/security.md).

The Dashboard has four pages and a login:

| Page | What you do |
|---|---|
| **Wallet** | Create the wallet. Write down the 12 words (shown once) and tick "I wrote them down". Send it a little USDC. It unlocks itself after a restart. |
| **Keys** | Issue one key per AI: daily, total and per-request limits, allowed hosts, approval line, expiry. The key and its skill paragraph are shown once; paste the paragraph into the AI. Limits are fixed once a key is issued: to change them, revoke the key and issue a new one. |
| **Approvals** | Approve or deny a payment that is over a key's approval line. |
| **Bills** | Every payment: time, key, amount, URL, chain, transaction hash, charged yes / no / maybe. |

The AI pays with `POST /v1/fetch`. Over the approval line the answer is `approval_required` with an `approval_id` and an `approve_url` (`{MONEYSWITCH_PUBLIC_URL}/approvals?id=…`). The skill tells the AI to hand the link to you and to poll `GET /v1/approvals/:id` every 15 seconds. The link carries no token: approving needs the administrator login. After approval the AI repeats the request with the `approval_id`. An approval expires after 10 minutes. There are no push channels.

`GET /skill.md` serves the generic skill, without a key. Skill + key is the integration; the plain HTTP call is the only other way in.

### First payment on a testnet

On an instance that enables testnets only (a mainnet enabled next to them turns it off), the key form offers "allow the test payment endpoint" (ticked by default; it adds `app.moneyswitch.dev:443` to the allowed hosts). The skill then asks the AI to make one test payment to `https://app.moneyswitch.dev/x402-testnet/check` and report the transaction hash. That endpoint is a test receiver on Monad testnet; the money has no value.

## Deploy on your own server

[Docker Compose and HTTPS](deploy/README.zh-CN.md): persistent volume, Caddy, health check, backup, rollback. **Do not run the server and the AI on the same machine under the same system user**: the AI could edit the database and get around the limits. Run one server writer per SQLite volume. Outbound requests follow `MONEYSWITCH_PROXY` (`off`, `auto` or a proxy URL), then `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, then the Windows system proxy.

## Networks and payment outcomes

Monad testnet (`eip155:10143`), Base Sepolia (`eip155:84532`), Monad mainnet (`eip155:143`), Base mainnet (`eip155:8453`). Testnets only by default: set `MONEYSWITCH_NETWORKS` to an explicit list and `MONEYSWITCH_DEFAULT_NETWORK` to a member of it; choosing a mainnet means real USDC. Each chain accepts only its own USDC, and one address has a separate balance on every chain. No swaps, no bridges. Only EIP-3009 payments are signed, never Permit2.

Every `/v1/fetch` answer says `charged: yes | no | maybe`. A payment that was signed but whose outcome is unknown is `payment_unknown`: **the AI must not retry it automatically**. The server looks it up on the chain later and fills in the transaction hash.

## What it does not do

Never: fiat on/off-ramp, swaps, bridges, issuing tokens, receiving or selling features, holding money for others. Not now: an employee portal UI, push channels, a model gateway, MCP, a command-line client, a local launcher, a desktop shell, wallet import, external wallets. Child keys keep their back end, without a UI. Old database tables stay. See [SPEC.md](SPEC.md) §8.

## Tests and licence

```sh
pnpm test
pnpm test:e2e
node scripts/deploy-smoke.mjs   # the built bundle, in a disposable directory
```

Offline tests verify real signatures with simulated settlement; real chain payments and a deployed HTTPS/persistence setup need their own acceptance run. Every external route is listed in `apps/server/test/unit/route-inventory.test.ts`.

Server, core and Dashboard: AGPL-3.0-only. `apps/demo-seller` and `apps/qwen-agent`: Apache-2.0 (`apps/qwen-agent` is left as it is and not maintained). See each package's LICENSE.
