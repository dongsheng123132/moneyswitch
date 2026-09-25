# MoneySwitch v0.1 — 实现规格（权威版）

> 本文件是 v0.1 的**唯一实现依据**。`docs/plan/执行书-chatgpt.md` 是背景材料；两者冲突时以本文件为准。
> 所有「已核实」的事实在 2026-09-25 实测过（链上读取 / npm / 官方文档），不要再凭记忆改。

## 0. 一句话

MoneySwitch = NewAPI for Agent Money。Agent 拿 `mk_live_xxx`（MoneyKey）通过 MoneySwitch 调 x402 收费接口，MoneySwitch 先过策略、再用本地低余额钱包签 USDC 授权。**Agent 永远拿不到私钥。**

v0.1 唯一成功标准：Claude Code 通过 Money MCP 调用 demo-seller 收费接口，在 **Monad 测试网**真实结算 0.01 USDC，链上可查到这笔 Transfer，Dashboard 显示用量。

## 1. 已核实的外部事实（写进 `packages/x402/src/networks.ts`，全部可被环境变量覆盖）

| 项 | 测试网（v0.1 默认） | 主网（v0.1 仅保留配置，默认禁用） |
|---|---|---|
| CAIP-2 | `eip155:10143` | `eip155:143` |
| RPC | `https://testnet-rpc.monad.xyz`（实测 chainId=0x279f） | 待定，环境变量提供 |
| USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| EIP-712 domain | name=`"USDC"`, version=`"2"`, decimals=6（链上实读） | name=`"USDC"`, version=`"2"`（官方文档；x402 issue #3102） |
| Facilitator | `https://x402-facilitator.molandak.org`（Monad 官方文档） | 同左 |
| Scheme | `exact`（EIP-3009 transferWithAuthorization） | 同左 |

- x402 SDK：`@x402/core @x402/evm @x402/fetch @x402/express @x402/mcp`，**锁死 `2.27.0`（精确版本，不用 ^）**。
- 测试网 USDC 不在 SDK 默认资产表里（PR #3570 未合并）：seller 端必须 `registerMoneyParser` 显式给出 asset 和 `extra: { name: "USDC", version: "2" }`，写法参考 https://docs.monad.xyz/guides/x402 。
- 测试币：USDC → https://faucet.circle.com ，MON（gas，本方案里由 facilitator 代付，但留着备用）→ https://faucet.monad.xyz 。**领水由用户手动完成，代码和 Agent 不要尝试自动领。**
- 客户端集成点（已在 2.27.0 的 d.ts 核实）：
  - `x402Client.registerPolicy((version, reqs) => reqs)` —— 过滤可选的 payment requirements；
  - `x402Client.onBeforePaymentCreation(ctx => { abort: true, reason })` —— **签名前最后一道闸，策略引擎挂在这里**；
  - `x402Client.setSpendControls(...)` —— SDK 自带的上限（默认单笔 $1），与我们策略同时存在；我们的策略是权威，SDK 的上限设为不低于我们的最大单笔上限，不要直接 `false` 关掉。
  - 服务端 facilitator 组件：`@x402/core/facilitator`、`@x402/evm/exact/facilitator`（离线测试用）。

## 2. 与执行书的差异 / 补充的决定

1. **Dashboard 由 server 静态托管**，同一端口 4020；compose 只起 `server` + `demo-seller`（4021）。
2. **管理鉴权与 MoneyKey 分离**：首次启动生成 `ms_admin_xxx`（只在 stdout 打印一次，库里存 hash）。管理路由只认 admin token；MoneyKey 访问管理路由一律 403。
3. **金额一律整数 micro-USDC（6 位）**存储与计算（SQLite INTEGER / TS bigint）；对外 API 用十进制字符串 `"0.01"`。禁止浮点参与金额计算。
4. **额度是「预留 → 结算/释放」模型**（参考 NewAPI 预扣）：签名前在同一个 SQLite 事务里检查并插入 `reserved` 记录；已用额度 = settled + reserved + unknown。
5. **审批区间**：`amount > per_request_limit` → DENY；`approval_threshold ≤ amount ≤ per_request_limit` → PENDING。创建 Key 时校验 `approval_threshold ≤ per_request_limit`（可为空=不需审批）。
6. **allowed_hosts 适用于所有 `/v1/fetch`**（包括免费请求）——它本质是出站代理。空列表 = 全部拒绝。
7. **Docker 本机当前没起**（Docker Desktop daemon 未运行）。所以 **`pnpm dev` / `pnpm start` 裸跑是 P0 路径**，docker-compose 文件照写，但验收不依赖 Docker。
8. 包管理用 **pnpm workspaces**（本机 pnpm 10.33）；Node 22。
9. LICENSE：许可证组合待用户确认，**v0.1 先不放 LICENSE 文件**，README 里写 "License: TBD"。

## 3. Repo 结构

```text
apps/
  server/        Fastify：Money API + 托管 dashboard 静态文件
  dashboard/     React + Vite
  mcp/           stdio MCP，纯 HTTP 客户端（不依赖 wallet/x402 包）
  demo-seller/   Express + @x402/express
packages/
  core/          moneykey / policy / ledger / approval / audit（纯逻辑，可单测）
  db/            Drizzle schema + migrations（better-sqlite3）
  wallet/        LocalWalletDriver（加密 keystore）
  x402/          networks.ts + 付款客户端封装
  mock-facilitator/  仅测试用，见 §9 T2
docs/  quickstart.md security.md claude.md codex.md demo.md
```

## 4. 数据模型（最少字段）

`money_keys`: id, name, key_prefix(明文前 12 位用于展示/查找), key_hash(sha256), enabled, total_budget, daily_budget, per_request_limit, approval_threshold(nullable), allowed_hosts(JSON), max_payments_per_minute(默认 10), expires_at(nullable), created_at, last_used_at。金额字段均为 micro-USDC 整数。

`payments`: id, key_id, url, host, method, network, asset, pay_to, amount, status(`reserved|settled|failed|unknown`), tx_hash, error_code, approval_id, created_at, updated_at。

`approvals`: id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status(`pending|approved|denied|expired|used`), expires_at(创建后 10 分钟), decided_at。

`audit_log`: id, actor(`admin|key:<id>|system`), action, detail(JSON，已脱敏), created_at。

`admin` 与 wallet 元数据按需建表。

MoneyKey 格式：`mk_live_` + 32 字节随机 base62。验证：按 prefix 查行，再对 sha256 做 `timingSafeEqual`。

## 5. Wallet（LocalWalletDriver）

- keystore：ethers v6 `Wallet.encrypt` / `Wallet.fromEncryptedJson`（scrypt）。文件在 `$MONEYSWITCH_DATA_DIR/wallet.json`（默认 `~/.moneyswitch/`，docker 里 `/data`）。
- 创建：`POST /v1/admin/wallet/create {password}` 生成新钱包（**不提供导入明文私钥的接口**，v0.1 只用新生成的低余额钱包）。
- 解锁：启动时读 `MONEYSWITCH_WALLET_PASSWORD` 或 `MONEYSWITCH_WALLET_PASSWORD_FILE`；也可 `POST /v1/admin/wallet/unlock`。解锁后的 signer 只在进程内存；锁定状态下 `/v1/fetch` 遇到 402 返回 `WALLET_LOCKED`。
- `GET /v1/admin/wallet`：地址、链上 USDC 余额（RPC 读 `balanceOf`）、锁定状态。
- 私钥、密码、签名原文永不进日志、永不出任何 API 响应。

## 6. Money API

管理（`Authorization: Bearer ms_admin_xxx`）：
```text
POST /v1/keys                 创建，响应里返回完整 key（仅此一次）
GET  /v1/keys                 列表（含 used_today / used_total）
POST /v1/keys/:id/revoke
GET  /v1/approvals            ?status=pending
POST /v1/approvals/:id/approve
POST /v1/approvals/:id/deny
GET  /v1/admin/usage          全局用量/流水
GET|POST /v1/admin/wallet[/create|/unlock]
```
Agent（`Authorization: Bearer mk_live_xxx`）：
```text
GET  /v1/status    { remaining_today, remaining_total, per_request_limit, currency:"USDC", network }
GET  /v1/history   ?limit=20
POST /v1/fetch
```

### `POST /v1/fetch` 精确流程

输入：`{ url, method?="GET", headers?, body?, max_price?, approval_id? }`

1. MoneyKey 鉴权 → enabled → 未过期 → **每分钟付款次数**未超 → URL 必须是 http(s)，host 在 allowed_hosts 内。
2. **SSRF**：永远拒绝指向 MoneySwitch 自身监听地址（任意 IP 形式的 4020 端口/本机 origin）的请求，allowlist 也不能放行。私网/回环地址只有在 allowed_hosts **显式写了该 host:port** 时才放行（demo-seller 走这条）。
3. 为本次请求新建一个 `x402Client`，注册 `ExactEvmScheme(signer)` 到配置的网络，用 `wrapFetchWithPayment` 发请求（超时 30s，响应体上限 1MB）。
4. `registerPolicy`：只保留 `scheme=exact && network=配置网络 && asset=配置 USDC（大小写不敏感）` 的 requirements；全部被滤掉 → `UNSUPPORTED_PAYMENT`。
5. `onBeforePaymentCreation`（签名前）：在**一个 SQLite 事务**里：
   - amount > per_request_limit → abort `PER_REQUEST_LIMIT_EXCEEDED`
   - `max_price` 给了且 amount > max_price → abort `MAX_PRICE_EXCEEDED`
   - 今日已用+amount > daily（UTC 日）→ `DAILY_BUDGET_EXCEEDED`；总已用+amount > total → `TOTAL_BUDGET_EXCEEDED`
   - amount ≥ approval_threshold 且未带有效 approval_id → 建 approval 记录，abort `APPROVAL_REQUIRED`
   - 带 approval_id：必须 status=approved、未过期、同 key、同 url/method/body_sha256，且本次 pay_to 相同、amount ≤ 批准额；通过后置为 `used`（一次性）
   - 全部通过 → 插入 `reserved` 付款记录
6. 请求完成后：从响应的 x402 settlement 响应头（用 SDK 的解码函数，不要手搓）拿到结算结果：
   - 有成功的 settle 结果 → `settled` + tx_hash（**不论响应体 HTTP 状态如何都计费**）
   - 明确失败（签名创建失败、facilitator 拒绝）→ `failed`，释放预留
   - 付款载荷已发出但结果未知（超时/断连）→ `unknown`，**继续占用额度**，Dashboard 标黄，审计留痕
7. 响应：
```json
{ "status": "ok|denied|approval_required|payment_failed|error",
  "code": "错误码或 null",
  "http_status": 200, "headers": {...白名单...}, "body": "...",
  "payment": { "amount": "0.01", "tx_hash": "0x..", "network": "eip155:10143" } | null,
  "approval_id": "..." | null,
  "remaining_today": "0.98", "remaining_total": "4.98" }
```

错误码全集：`KEY_INVALID KEY_REVOKED KEY_EXPIRED RATE_LIMITED HOST_NOT_ALLOWED SSRF_BLOCKED UNSUPPORTED_PAYMENT PER_REQUEST_LIMIT_EXCEEDED MAX_PRICE_EXCEEDED DAILY_BUDGET_EXCEEDED TOTAL_BUDGET_EXCEEDED APPROVAL_REQUIRED APPROVAL_INVALID WALLET_LOCKED PAYMENT_FAILED UPSTREAM_ERROR FORBIDDEN`。

## 7. MCP（apps/mcp）

- 官方 `@modelcontextprotocol/sdk`，stdio。环境变量 `MONEY_API_BASE`、`MONEY_API_KEY`。只做 HTTP 转发，**不依赖 wallet / x402 包**。
- 工具：`money_status()`、`paid_fetch(url, method?, headers?, body?, max_price?, approval_id?)`、`money_history(limit?)`。
- `paid_fetch` 返回 `approval_required` 时，文案要明确告诉 Agent：「已提交人工审批 approval_id=…，等用户批准后用同一参数加 approval_id 重试」。
- docs/claude.md：`claude mcp add moneyswitch -e MONEY_API_BASE=http://127.0.0.1:4020 -e MONEY_API_KEY=mk_live_xxx -- node <abs>/apps/mcp/dist/index.js`；docs/codex.md：`~/.codex/config.toml` 的 `[mcp_servers.moneyswitch]` 写法。

## 8. demo-seller（apps/demo-seller，端口 4021）

`@x402/express` + `x402ResourceServer` + `HTTPFacilitatorClient`，facilitator URL 可配置（默认 molandak；测试时指向 mock-facilitator）。payTo 由 `DEMO_SELLER_PAY_TO` 提供（**不能等于** MoneySwitch 钱包地址）。

| 路由 | 价格 | 演示用途 |
|---|---|---|
| `GET /free` | 免费 | $0 请求 |
| `GET /premium-report` | 0.01 | 正常付款 |
| `GET /deep-report` | 0.15 | 配合 threshold=0.10 触发审批 |
| `GET /greedy` | 5.00 | 被单笔上限拦截 |

## 9. 测试分三层

**T1 单元/集成（`pnpm test`，离线，必须全绿）**：
- 执行书 §17 全部 DENY/ALLOW/PENDING 用例；
- 新增：asset 不符 / network 不符 → `UNSUPPORTED_PAYMENT`；`max_price`；RATE_LIMITED；MoneyKey 调管理路由 → 403；SSRF 访问自身 4020 → `SSRF_BLOCKED`；approval 复用第二次 → `APPROVAL_INVALID`；approval 后改 URL → `APPROVAL_INVALID`；
- **并发**：daily=1.00，并发 10 个 0.15 的付款 → 恰好 6 个 settled、4 个 `DAILY_BUDGET_EXCEEDED`；
- **脱敏**：跑完整套测试后 grep 所有日志输出，不得出现完整 MoneyKey、admin token、私钥、keystore 密码。

**T2 离线端到端（`pnpm test:e2e`，无网络）**：mock-facilitator 用 viem `verifyTypedData` **真实校验** EIP-3009 签名（domain = {name:"USDC", version:"2", chainId:10143, verifyingContract: 测试网 USDC}），settle 返回伪 tx hash，且伪 hash 必须以 `0xmock` 开头的约定形式/或在 settle 响应里带 `mock:true`，Dashboard 与 usage 显示 `MOCK`。链路：MCP 客户端 → server → demo-seller → 402 → 签名 → mock verify/settle → 200 → usage +0.01。

**T3 测试网实测（`MONEYSWITCH_E2E_TESTNET=1 pnpm test:testnet`，需用户领水）**：
- 不需资金的部分**默认就跑**（有网时）：RPC `eth_chainId == 10143`；USDC `name()=="USDC"`、`version()=="2"`、`decimals()==6` 与 networks.ts 一致；
- 需资金部分：真实 facilitator，付 0.01 → 拿 tx_hash → 用 RPC 取 receipt，断言存在 USDC `Transfer(from=钱包, to=DEMO_SELLER_PAY_TO, value=10000)`。**「签名成功」不算通过，链上 Transfer 才算。**

## 10. Dashboard（NewAPI 风格，最后做）

页面：Overview（钱包地址+USDC 余额、今日 used/limit 进度条、各 Key 用量）/ MoneyKeys（创建弹窗只显示一次完整 key + 一键复制 Claude/Codex 配置片段）/ Usage（流水，含 tx 链接到 Monad 测试网浏览器，MOCK/unknown 标记）/ Approvals（Approve/Deny）/ Wallet（创建、解锁、地址二维码）。登录用 admin token，存 sessionStorage。轮询 3s 刷新即可，不上 WebSocket。

## 11. 里程碑与验收（每个里程碑的证据由 judge 收集原始输出）

| M | 内容 | 验收证据 |
|---|---|---|
| M1 | 脚手架、db、MoneyKey、Policy、admin 鉴权 | `pnpm test` 输出（T1 中 policy/key/auth 部分） |
| M2 | LocalWalletDriver + x402 客户端 + demo-seller + mock-facilitator + `/v1/fetch` | `pnpm test:e2e` 输出；curl 调 `/v1/fetch` 的原始响应 |
| M3 | Approvals + 并发 + SSRF + 脱敏 | `pnpm test` 全量输出 |
| M4 | MCP + Claude Code/Codex 文档 | 用 MCP 客户端脚本调三个工具的原始输出 |
| M5 | Dashboard | 浏览器截图（主会话自己看） |
| M6 | 测试网真实结算 | `test:testnet` 输出 + tx hash（主会话自行上链复核） |

## 12. 明确不做（v0.1）

MetaMask/OKX 驱动、导入私钥、主网默认开启、跨链、Swap、法币出入金（**尤其是「法币买 USDC」，合规风险，开源项目里永不做**）、多用户/组织、Postgres/Redis、Tauri 桌面壳、自动领水、`upto` scheme、自己实现 402/EIP-712。

## 13. 已知风险提示（写进 docs/security.md）

- 若 Agent 与 MoneySwitch 在**同一 OS 用户**下运行，Agent 有 shell 就能直接改 SQLite 或读 keystore。推荐 MoneySwitch 在独立用户 / 容器 / 另一台机器运行，数据目录权限仅对该用户可读。
- 单笔上限挡不住小额连刷：真正的防线是 allowed_hosts + 日额度 + 每分钟次数。
- `unknown` 状态付款保守计入额度，需人工在 Dashboard 核对。
