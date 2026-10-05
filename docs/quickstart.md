# Quickstart

The goal (SPEC.md §0): a new user gets their own AI to make a first **testnet** payment within ten minutes. Everything below runs locally; nothing here uses real money.

## 1. Install and build

```bash
pnpm install
pnpm build
```

## 2. Start the server

```bash
MONEYSWITCH_DATA_DIR=~/.moneyswitch MONEYSWITCH_PORT=4020 node apps/server/dist/index.js
```

(or `node apps/server-pkg/dist/cli.js --data-dir ~/.moneyswitch --port 4020`.) Without further settings only Monad testnet is enabled (`MONEYSWITCH_NETWORKS` adds Base Sepolia or a mainnet; a mainnet means real USDC). On the first start this prints an administrator token **exactly once**, followed by a one-time sign-in link:

```
[moneyswitch] Admin token (save this now, it will not be shown again):
  ms_admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

[moneyswitch] First-run sign-in: open this one-time link in your browser (valid 30 min, single use):
  http://127.0.0.1:4020/login#ms_setup_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Save the administrator token: only its hash is stored (lost? see the end of this file). The sign-in link works once, expires after 30 minutes and does not survive a restart. If the AI will reach this server by another address, also set `MONEYSWITCH_PUBLIC_URL` (approval links and the skill text use it).

## 3. Wallet

Open the link: it signs you in and lands on the **Wallet** page. Click *Create wallet*. There is no password to choose: the server keeps an unlock file in its data folder and opens the wallet by itself after every restart. **Anyone who can read that folder can spend the wallet**, so keep only small amounts in it and do not run your AI as the same system user ([wallet-setup.md](wallet-setup.md), [security.md](security.md)).

The 12 recovery words are shown **once**. Write them down, tick "I wrote all 12 words down", and the page shows the wallet address and its balance on every enabled chain. Fund the address with testnet USDC (the page links to the faucet; Monad testnet needs no gas token).

## 4. A key for your AI

On the **Keys** page issue a key: a name, a total, a daily and a per-request limit, an optional approval line, allowed hosts and an expiry. On an instance that enables testnets only, leave "allow the test payment endpoint" ticked (it adds `app.moneyswitch.dev:443` to the allowed hosts). The key and its **skill paragraph** are shown once. Paste the paragraph into your AI (Claude Code, Codex, OpenClaw, Hermes, ...). Lost the key? *Reset secret and copy skill* revokes the old secret, keeps the limits and history, and gives a new paragraph. Limits cannot be changed after issuing: to change them, revoke the key and issue a new one.

The skill tells the AI to read `GET /v1/status` and then make one test payment to `https://app.moneyswitch.dev/x402-testnet/check` and report the transaction hash. The same thing by hand:

```bash
curl -X POST http://127.0.0.1:4020/v1/fetch \
  -H "Authorization: Bearer $MONEY_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://app.moneyswitch.dev/x402-testnet/check","method":"GET","max_price":"0.01"}'
```

The **Bills** page then shows the payment: time, key, amount, URL, chain, transaction hash and `charged` (yes / no / maybe).

## 5. An approval

Give a key an approval line below the price (for example `0.005` with the 0.01 test endpoint). `/v1/fetch` then answers `approval_required` with an `approval_id` and an `approve_url` such as `http://127.0.0.1:4020/approvals?id=…`. The skill makes the AI hand that link to you and poll `GET /v1/approvals/:id` every 15 seconds. Open the link, sign in if asked (the link itself carries no token, so you are sent back to the same approval afterwards) and approve or deny. The AI then repeats the request with the `approval_id`. An approval expires after 10 minutes.

## The same through the API

```bash
# a key (administrator token)
curl -X POST http://127.0.0.1:4020/v1/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my-agent","total_budget":"10","daily_budget":"5","per_request_limit":"1","approval_threshold":"0.10","allowed_hosts":["app.moneyswitch.dev:443"]}'
```

The response includes the full `mk_live_…` key **only this once**. The administrator routes are listed in `apps/server/test/unit/route-inventory.test.ts`; the wallet ones in [wallet-setup.md](wallet-setup.md).

## Offline: your own test seller

To try a priced endpoint without the public test receiver, run the mock facilitator and `apps/demo-seller` locally (nothing is spent):

```bash
MOCK_FACILITATOR_PORT=4099 node packages/mock-facilitator/dist/server.js
DEMO_SELLER_PORT=4021 DEMO_SELLER_PAY_TO=0xYourDemoSellerAddress \
DEMO_SELLER_FACILITATOR_URL=http://127.0.0.1:4099 node apps/demo-seller/dist/index.js
```

`DEMO_SELLER_PAY_TO` must not be the MoneySwitch wallet's address. Put `127.0.0.1:4021` into the key's allowed hosts and call `http://127.0.0.1:4021/premium-report` through `/v1/fetch`. For a real Monad testnet run with the real facilitator (needs a funded wallet): `DEMO_SELLER_PAY_TO=0xYourAddress pnpm demo:testnet`. It starts the test seller and the server; it does not fund or pay anything by itself.

Even though the facilitator is the offline mock, the wallet is still looked at: before paying, MoneySwitch reads its USDC balance on the chain the seller quotes in (the demo seller quotes Monad testnet), so the wallet needs **testnet USDC on that chain** (the faucet link is on the Wallet page). Without it `/v1/fetch` answers `INSUFFICIENT_FUNDS` and nothing is signed. If that chain's RPC cannot be reached, the balance is simply unknown and the payment is tried as usual.

## 丢了 admin token 怎么办

admin token（`ms_admin_xxx`）只在数据目录**第一次**启动时打印一次，库里只存了它的哈希——没有任何办法把原文找回来。丢了不代表要删库重来：

```bash
pnpm build   # 确保脚本依赖的 @moneyswitch/db、@moneyswitch/core 已构建
pnpm admin:reset-token -- --data-dir ~/.moneyswitch
```

同一段代码也是 `moneyswitch-server` 的子命令，npm 安装和 Docker 镜像里都能用（必须在服务器本机、用运行服务的那个系统用户执行）：

| 部署方式 | 命令 |
|---|---|
| 源码（本文的方式） | `pnpm admin:reset-token -- --data-dir ~/.moneyswitch` |
| npm 安装 | `moneyswitch-server reset-admin-token --data-dir <数据目录>` |
| 源码构建出的包 | `node apps/server-pkg/dist/cli.js reset-admin-token --data-dir <数据目录>` |
| Docker | `docker compose exec server node /app/dist/cli.js reset-admin-token`（见 [deploy/README.zh-CN.md](../deploy/README.zh-CN.md)） |

（把 `~/.moneyswitch` 换成你实际的 `MONEYSWITCH_DATA_DIR`；`pnpm demo:testnet` 用的是 `.data/testnet`。）

这条命令直接操作该数据目录下的 `moneyswitch.sqlite`，生成一个新 admin token 并替换掉存储的哈希——**旧 token 立刻失效**，新 token 只打印这一次，同样不会被再次显示。server 不需要先停掉再跑这条命令：数据库是 WAL 模式，允许这条命令和正在运行的 server 同时读写同一个文件。跑完把新 token 记下来，其余管理接口（创建 Key、审批等）照常用新 token 调用即可。

不要对生产/测试网环境正在使用的数据目录随手跑这条命令——它会让所有已经分发出去的旧 admin token 立刻失效，需要重新分发。
