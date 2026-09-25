# MoneySwitch v0.1 — Claude Code 开发执行书

## 0. 项目一句话

**MoneySwitch = NewAPI for Agent Money。**

让 Claude、Codex、WorkBuddy、OpenClaw 等 AI Agent 像使用 API Key 一样使用钱，而不是直接持有钱包私钥。

第一版只做：

**Monad + USDC + x402 + MoneyKey + Quota + Usage + MCP。**

不发币、不造支付协议、不做跨链、不做交易所、不做完整钱包。

---

## 1. 第一版目标

先做“服务器端、单机自托管版”。

用户在一台电脑或一台服务器上启动 MoneySwitch：

```text
docker compose up -d
```

然后打开：

```text
http://localhost:4020
```

完成四件事：

1. 配置一个低余额 USDC Agent Vault。
2. 创建一个 MoneyKey，例如 `mk_live_xxx`。
3. 把这个 MoneyKey 配给 Claude/Codex。
4. Agent 通过 MoneySwitch 调用一个 x402 收费 API，并在 Monad 上支付第一笔 USDC。

**v0.1 唯一成功标准：**

> Claude/Codex 拿着 MoneyKey，通过 MoneySwitch 成功支付一个 x402 服务，而 Agent 从始至终拿不到钱包私钥。

---

## 2. 产品边界

### MoneySwitch 负责

- MoneyKey 创建、撤销、哈希存储
- 总额度、日额度、单笔额度
- 域名/服务白名单
- 过期时间
- 人工审批阈值
- Usage / Logs / Audit
- x402 自动支付
- Agent MCP 接入
- Dashboard
- 钱包 Driver 抽象

### MoneySwitch 不负责

- 新稳定币
- 新 Token
- 法币兑换
- Swap
- 跨链桥
- NFT
- DAO
- DEX
- 银行卡收单
- 完整 MetaMask 替代品
- 自己重新实现 x402

---

## 3. 核心架构

```text
Claude / Codex / WorkBuddy
          │
          │ MoneyKey
          ▼
┌──────────────────────┐
│     MoneySwitch      │
│                      │
│ Money API            │
│ Policy Engine        │
│ Usage / Audit        │
│ Approval             │
│ Wallet Driver        │
└──────────┬───────────┘
           │
           │ x402
           ▼
      Monad + USDC
           │
           ▼
       x402 Seller
```

第一版所有服务允许运行在同一台机器。

未来企业版只需要把：

```text
http://127.0.0.1:4020
```

换成：

```text
https://money.company.com
```

Agent 接口不变。

---

## 4. 技术栈

建议全部 TypeScript：

| 层 | 选择 |
|---|---|
| Runtime | Node.js 22+ |
| API | Fastify |
| Web | React + Vite |
| DB | SQLite（v0.1） |
| ORM | Drizzle |
| EVM | viem |
| x402 | 官方 x402 SDK |
| MCP | 官方 MCP SDK |
| Auth | MoneyKey Bearer Token |
| Packaging | Docker Compose |
| Tests | Vitest |
| Lint | ESLint |
| Format | Prettier |

v0.1 不上 Kubernetes、不上 Redis、不上 Postgres。

---

## 5. Repo 结构

```text
moneyswitch/

apps/
  server/
  dashboard/
  mcp/
  demo-seller/

packages/
  core/
    moneykey/
    policy/
    ledger/
    approval/
    audit/

  x402/
  wallet/
    local/

  db/

docs/
  architecture.md
  security.md
  quickstart.md
  claude.md
  codex.md
  demo.md

docker-compose.yml
.env.example
README.md
LICENSE
```

如果 monorepo 造成明显拖慢，可以合并 `server + mcp`。

---

## 6. MoneyKey

示例：

```text
mk_live_xxxxxxxxxxxxxxxxx
```

数据库禁止保存完整 Key，只保存：

```text
key_prefix
key_hash
```

创建后只展示一次。

MoneyKey 数据模型：

```text
id
name
key_prefix
key_hash
enabled

total_budget_usdc
total_used_usdc

daily_budget_usdc
per_request_limit_usdc
approval_threshold_usdc

allowed_hosts
expires_at

created_at
last_used_at
```

---

## 7. Money API

v0.1 至少实现：

```text
POST /v1/keys
GET  /v1/keys
POST /v1/keys/:id/revoke

GET  /v1/status
GET  /v1/usage
GET  /v1/history

POST /v1/fetch

GET  /v1/approvals
POST /v1/approvals/:id/approve
POST /v1/approvals/:id/deny
```

Agent 使用：

```text
Authorization: Bearer mk_live_xxx
```

### 最关键接口

```text
POST /v1/fetch
```

输入：

```json
{
  "url": "https://seller.example/premium-report",
  "method": "GET"
}
```

流程：

```text
普通请求
→ 如果 200，直接返回
→ 如果 402，读取 x402 payment requirement
→ Policy Engine 检查
→ 自动签 USDC authorization
→ 重试
→ 返回资源
→ 写 usage/log
```

---

## 8. Policy Engine

支付签名之前必须按顺序检查：

```text
Key 是否存在
→ enabled?
→ expired?
→ host allowed?
→ 单笔额度够?
→ 当日额度够?
→ 总额度够?
→ 是否需要人工审批?
→ PAY / PENDING / DENY
```

禁止先签名后检查。

标准错误码至少包括：

```text
KEY_INVALID
KEY_REVOKED
KEY_EXPIRED
HOST_NOT_ALLOWED
PER_REQUEST_LIMIT_EXCEEDED
DAILY_BUDGET_EXCEEDED
TOTAL_BUDGET_EXCEEDED
APPROVAL_REQUIRED
PAYMENT_FAILED
```

---

## 9. Wallet

v0.1 先实现一个：

```text
LocalWalletDriver
```

只用于低余额 Agent Vault。

私钥必须加密存储，不允许明文 `.env`。

建议使用成熟 keystore 加密格式。

第一版配置：

```text
~/.moneyswitch/
  wallet.json
  moneyswitch.db
```

钱包解锁后 signer 仅存在进程内存。

以后增加：

```text
MetaMask Agent Wallet Driver
EIP-1193 Driver
OKX Driver
Safe Driver
HSM / KMS Driver
```

但不要阻塞 v0.1。

---

## 10. MCP

提供一个 Money MCP。

第一版只暴露：

```text
money_status
paid_fetch
money_history
```

### money_status

返回：

```json
{
  "remaining_today": "1.84",
  "remaining_total": "4.22",
  "currency": "USDC"
}
```

### paid_fetch

输入 URL，MoneySwitch 自动处理 HTTP 402/x402。

### money_history

返回最近消费。

Claude/Codex 不应该接触：

```text
wallet private key
USDC contract
Monad RPC
x402 signature details
```

它们只看到 Money Tool。

---

## 11. Demo Seller

必须在仓库自带一个可控的收费服务：

```text
apps/demo-seller
```

接口：

```text
GET /premium-report
```

价格：

```text
0.01 USDC
```

使用当前官方 x402 server SDK。

响应：

```json
{
  "company": "MoneySwitch Demo Corp",
  "score": 92,
  "paid": true
}
```

它用于自动测试和黑客松演示。

---

## 12. Dashboard

不要设计成传统 Web3 钱包。

参考 API Console / NewAPI。

首页：

```text
MoneySwitch

Treasury
$20.00 USDC

Today
$0.17 / $5.00

Agents
Claude      $0.10 / $2
Codex       $0.05 / $2
WorkBuddy   $0.02 / $1
```

核心页面：

```text
Overview
MoneyKeys
Usage
Approvals
Wallet
Settings
```

MoneyKeys 页面：

```text
NAME       USED       LIMIT       STATUS

Claude     $0.72      $2/day      Active
Codex      $0.31      $2/day      Active
U-King     $0.09      $1/day      Active
```

---

## 13. 人工审批

如果支付金额大于：

```text
approval_threshold
```

返回：

```json
{
  "status": "approval_required",
  "approval_id": "...",
  "amount": "0.80"
}
```

Dashboard 出现：

```text
Claude wants to spend $0.80

Host:
example.ai

[ Deny ] [ Approve ]
```

用户点击 Approve 后再执行付款。

---

## 14. 第一版 Agent 适配

优先级：

```text
P0 Claude Code
P0 Codex
P1 WorkBuddy
P1 OpenClaw
P2 U-King
```

做一个极薄的本地 Adapter：

```text
MONEY_API_BASE=http://127.0.0.1:4020
MONEY_API_KEY=mk_live_xxx
```

Adapter 暴露 stdio MCP。

未来企业版：

```text
MONEY_API_BASE=https://money.company.com
```

即可。

---

## 15. Docker Compose

目标：

```bash
git clone ...
cd moneyswitch
cp .env.example .env
docker compose up -d
```

至少拉起：

```text
moneyswitch-server
moneyswitch-dashboard
demo-seller
```

MCP 可以单独通过 npm/CLI 启动。

---

## 16. 安全底线

必须做到：

```text
MoneyKey 哈希存储
Wallet 私钥加密存储
Agent 永不拿 master private key
Policy 在签名前执行
默认低余额 Agent Vault
默认关闭任意地址自由转账
默认只支持 x402 支付
所有支付写 Audit Log
Key 可即时 revoke
```

日志中不得打印完整：

```text
private key
MoneyKey
签名敏感材料
```

---

## 17. 自动化测试

至少覆盖：

```text
有效 Key → ALLOW
错误 Key → DENY
revoked Key → DENY
expired Key → DENY

超过单笔额度 → DENY
超过 daily budget → DENY
超过 total budget → DENY

host 不允许 → DENY

达到审批阈值 → PENDING
Approve → PAY
Deny → DENY

x402 正常支付 → SUCCESS
支付后 usage 正确增加
```

必须有端到端测试：

```text
MCP
→ MoneySwitch
→ demo seller
→ HTTP 402
→ x402 payment
→ Monad
→ HTTP 200
```

---

## 18. 黑客松 90 秒 Demo

```text
1. 打开 MoneySwitch
2. Treasury 显示 5 USDC
3. Create MoneyKey: Claude
4. Daily = $1
5. Per Request = $0.20
6. Claude 调免费 URL → $0
7. Claude 调 demo paid API → $0.01
8. Dashboard 变成 $0.01 / $1
9. 再调用一次 → $0.02 / $1
10. 模拟 $5 请求
11. MoneySwitch BLOCKED
12. Revoke Claude Key
13. Claude 再请求 → KEY_REVOKED
```

---

## 19. 开源策略

建议先拆两层许可证：

```text
SDK / MCP / adapters:
Apache-2.0

Server / Dashboard:
AGPL-3.0
```

目的：

- Agent 适配层尽量容易被生态采用。
- Server 允许自托管。
- 避免云厂商直接闭源托管修改版。

正式商业化前再请专业律师确认许可证组合。

---

## 20. GitHub 首页定位

README 第一屏：

```text
# MoneySwitch

Give AI an API key for money.

Claude, Codex and other agents already understand API keys.
MoneySwitch gives them a MoneyKey with budget, policy and audit.

USDC · Monad · x402
```

架构图：

```text
AI Agent
   │
MoneyKey
   │
MoneySwitch
   │
Quota / Policy / Usage
   │
x402
   │
Monad + USDC
```

---

## 21. 开发顺序

Claude Code 请严格按下面顺序执行，不要先做漂亮 UI：

1. 初始化 repo / Docker / SQLite。
2. 实现 MoneyKey + Policy Engine。
3. 实现 LocalWalletDriver。
4. 接官方 x402 client。
5. 做 demo-seller。
6. 跑通 `/v1/fetch` 端到端支付。
7. 实现 MCP。
8. 接 Claude Code。
9. 接 Codex。
10. 做 Dashboard。
11. 加 Approvals。
12. 加完整测试。
13. 写 README 和 Quick Start。
14. 实际执行完整 90 秒 Demo。

---

## 22. Claude Code 执行要求

不要只输出设计文档。

必须：

```text
创建真实文件
安装依赖
运行 migration
启动服务
运行测试
修复报错
完成 E2E
```

每完成一个里程碑都执行：

```text
npm test
```

以及实际 HTTP/MCP 测试。

遇到 Monad/x402 SDK 版本差异时，以当前官方 SDK 与官方文档为准，不自己复制过时博客实现。

---

## 23. v0.1 完成定义

下面全部满足才算完成：

```text
docker compose up 能启动

Dashboard 能打开

能创建 MoneyKey

Claude 或 Codex 能连接 Money MCP

paid_fetch 能访问 demo-seller

402 能自动转为 x402 USDC 支付

支付成功后返回资源

Usage 能正确显示

超额能阻断

Key revoke 立即生效

README 新用户 10 分钟内能跑起来
```

完成后再做：

```text
v0.2 MetaMask/OKX 入金
v0.3 WorkBuddy/OpenClaw adapters
v0.4 Organization / Multi-user
v0.5 Enterprise RBAC / Approval / Audit
```
