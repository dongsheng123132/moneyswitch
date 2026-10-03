# MoneySwitch

**AI 拿一把有额度的 key 去付 x402，超过审批线找人批，私钥永远不交给 AI。**

官网：[moneyswitch.dev](https://moneyswitch.dev) · [English](README.md) · [规格](SPEC.md) · [自建部署](deploy/README.zh-CN.md)

[SPEC.md](SPEC.md) 是唯一有效的规格。本文只说怎么跑起来。

## 从代码运行

需要 Node.js 22+ 和 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server-pkg/dist/cli.js --data-dir ./data
```

首次启动会打印管理员令牌和一条一次性登录链接（30 分钟内有效，只能用一次）。打开链接：自动登录并停在「钱包」页。请把 `MONEYSWITCH_PUBLIC_URL` 设成大家访问这台服务的地址，审批链接和技能说明都用它。

后台只有 4 个页面加登录：

| 页面 | 做什么 |
|---|---|
| **钱包** | 创建钱包，12 个词只显示一次，抄下后勾选「我已抄下」，再转入少量 USDC。重启后自动解锁。 |
| **Key** | 一个 AI 一把：日额度、总额度、单笔上限、允许的域名、审批线、过期时间。创建后 key 和技能段落只显示一次，把技能段落粘贴给 AI。 |
| **审批** | 批准或拒绝超过审批线的付款。 |
| **账单** | 每一笔：时间、key、金额、网址、链、交易号、扣款状态（yes / no / maybe）。 |

AI 用 `POST /v1/fetch` 付款。超过审批线时返回 `approval_required`，带 `approval_id` 和 `approve_url`（`{MONEYSWITCH_PUBLIC_URL}/approvals?id=…`）。技能让 AI 把链接发给你，并每 15 秒查一次 `GET /v1/approvals/:id`。链接本身不含令牌，批准必须先以管理员身份登录；批准后 AI 带 `approval_id` 原样重发。审批 10 分钟过期。不做推送渠道。

公开的 `GET /skill.md` 是不含 key 的通用说明。接入方式只有「技能 + key」，另外就是直接调用 HTTP 接口。

### 测试网上的第一笔

默认网络是测试网时，建 key 的表单有「允许测试付款接口」（默认勾选，会把 `app.moneyswitch.dev:443` 加进允许域名）。技能随后会让 AI 向 `https://app.moneyswitch.dev/x402-testnet/check` 付一笔测试款，并报告交易号。这个接口是 Monad 测试网上的测试收款端，钱没有价值。

## 自己的服务器

[部署说明](deploy/README.zh-CN.md)：Docker Compose、HTTPS/Caddy、持久数据卷、健康检查、备份和回滚。**不要把服务和 AI 放在同一台机器、同一个系统用户下**：AI 能直接改数据库、绕过额度。同一个 SQLite 数据卷只运行一个写入实例。出站请求按 `MONEYSWITCH_PROXY`（`off`、`auto` 或代理地址）、`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`、Windows 系统代理的顺序选代理。

## 支持的链与付款结果

| 网络 | CAIP-2 |
|---|---|
| Monad 测试网 | eip155:10143 |
| Base Sepolia | eip155:84532 |
| Monad 主网 | eip155:143 |
| Base 主网 | eip155:8453 |

默认只开测试网：`MONEYSWITCH_NETWORKS` 给出允许列表，`MONEYSWITCH_DEFAULT_NETWORK` 必须在其中；启用主网就是真实 USDC。每条链只认自己的 USDC，同一地址在各链的余额独立。不换币、不跨链。只签 EIP-3009，不签 Permit2。

每次 `/v1/fetch` 的返回都带 `charged: yes | no | maybe`。已签名但结果不明的付款是 `payment_unknown`，**AI 不得自动重试**；服务稍后到链上对账并补上交易号。

## 不做什么

永远不做：法币出入金、换币、跨链桥、发币、收款 / 卖方功能、替别人保管钱。现在不做：员工门户界面、推送渠道、模型网关、MCP、命令行客户端、本机启动器、桌面壳、导入钱包、外部钱包。子 key 的后端逻辑保留，没有界面。数据库里的旧表保留。详见 [SPEC.md](SPEC.md) §8。

## 验证与许可

```sh
pnpm test
pnpm test:e2e
node scripts/deploy-smoke.mjs   # 在一次性目录里验收已构建的包
```

离线测试使用真实签名和模拟结算，不代表真实链上付款；部署验收另核对 HTTPS、持久化、重启和备份。每个对外接口都登记在 `apps/server/test/unit/route-inventory.test.ts`。

服务端、核心和 Dashboard：AGPL-3.0-only；`apps/demo-seller` 和 `apps/qwen-agent`：Apache-2.0（`apps/qwen-agent` 原样保留、不维护）。详见各包 LICENSE。
