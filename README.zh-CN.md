# MoneySwitch

[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2F%20Apache--2.0-blue)](#license)
[![CI](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/moneyswitch)](https://www.npmjs.com/package/moneyswitch)

**给你的 AI 一把花钱的 API Key。**

[English →](README.md)

AI Agent 拿到的是一把 `mk_live_xxx` **MoneyKey**——不是钱包私钥——通过
[x402](https://x402.org) 协议在 [Monad](https://monad.xyz) 测试网上用 USDC
调用收费的 HTTP 接口。MoneySwitch 在每一笔付款**之前**先过策略（预算、单笔
上限、审批阈值、host 白名单、SSRF 防护），再用本地持有的低余额钱包自己签名
USDC 授权。**Agent 永远拿不到私钥。**

<!-- screenshot: dashboard-overview -->

## 为什么这么做

AI 已经被这个行业教育过一次：拿一串以特定前缀开头的字符串（`sk-…`、
`mk_live_…`），塞进 `Authorization` 头，剩下的交给平台。MoneySwitch 把同一
套模式原样搬来管钱，而不是再发明一套——不需要钱包插件、不需要助记词、不需要
Agent 点弹窗签名。Agent 用 bearer token 调 HTTP 接口；MoneySwitch 站在这个
token 和链上 USDC 转账之间，用发 API Key 的平台早就熟悉的那套限速/限额逻辑
去约束它。

## 30 秒上手

把已有的 MoneySwitch 服务器 + MoneyKey 接进本机的 Claude Code / Codex：

```bash
npx moneyswitch connect --server http://127.0.0.1:4020 --key mk_live_xxx --apply
```

这条命令会探测本机的 Claude Code / Codex 并自动接好 MoneySwitch 的 MCP
服务器（默认 dry-run——先去掉 `--apply` 看看它打算做什么）。
`npx moneyswitch status --server ... --key ...` 查一把 Key 的剩余额度；
`npx moneyswitch remove --apply` 撤销接入。

自托管服务器：

```bash
pnpm install
pnpm build
pnpm demo:local
```

`pnpm demo:local` 会同时起一个离线 mock 的 x402 facilitator、一个 demo x402
卖方、和带 Dashboard 界面的 MoneySwitch 服务器——全程离线，不会发生真实付
款。真实 Monad 测试网路径（`pnpm demo:testnet`）与手动分步版本见
[`docs/quickstart.md`](docs/quickstart.md)。

## 架构

```text
                      mk_live_xxx（MoneyKey，不是私钥）
                              │
   ┌──────────────┐   MCP / OpenAI 兼容 / REST         ┌────────────────────┐
   │   AI Agent    │ ───────────────────────────────►  │  MoneySwitch 服务器  │
   │ (Claude Code, │                                    │  (apps/server)      │
   │  Codex, ...)  │ ◄─────────────────────────────── │  策略引擎 → 钱包      │
   └──────────────┘        结果 / 用量 / 错误           │  (apps/dashboard)   │
                                                          └─────────┬──────────┘
                                                                    │ x402 (EIP-3009 USDC 授权)
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │   x402 facilitator  │
                                                          │    (链上结算)        │
                                                          └─────────┬──────────┘
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │   Monad 测试网       │
                                                          │  USDC Transfer      │
                                                          └─────────┬──────────┘
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │  x402 卖方 /         │
                                                          │  收费接口            │
                                                          └────────────────────┘
```

私钥存在服务器一侧的加密、低余额本地钱包里（`packages/wallet`）；Agent 进
程从始至终拿不到它。每一笔付款在产生签名**之前**都要在一个数据库事务里过完
策略检查（`packages/core`）。

## 三种接入方式

1. **MCP**（`apps/mcp`，stdio）——`money_status`、`paid_fetch`、
   `money_history` 三个工具。`npx moneyswitch mcp`，或用 `moneyswitch
   connect --apply` 自动接入 Claude Code / Codex。见
   [`docs/claude.md`](docs/claude.md)、[`docs/codex.md`](docs/codex.md)。
2. **OpenAI / NewAPI 兼容网关**——在任意支持 OpenAI SDK 协议的客户端
   （openai SDK、Cherry Studio、Open WebUI、NewAPI 上游渠道）里填
   `Base URL = http://<server>/v1`、`API Key = mk_live_xxx`。已实现
   `GET /v1/models`、`POST /v1/chat/completions` 与旧版 OpenAI billing 接
   口——见 [`SPEC-v0.2.md`](SPEC-v0.2.md) 与
   [`docs/money-api-v0.md`](docs/money-api-v0.md)。
3. **REST**——`POST /v1/fetch { url, method?, headers?, body?, max_price? }`
   直接通过策略引擎请求任意 x402 收费 URL。见
   [`docs/money-api-v0.md`](docs/money-api-v0.md)。

## 角色

| 角色 | 拿什么 | 在哪用 | 能做什么 |
|---|---|---|---|
| 管理员（老板/财务） | `ms_admin_…` | Dashboard | 钱包、渠道、给每个 Agent 开/收 Key、审批、看全公司用量 |
| 员工 | 一把或几把 `mk_live_…` | Dashboard「我的额度」视图 + 桌面 CLI | 看自己额度/流水、Playground、一键把 Key 配进本机 Agent；不能看别人、不能碰钱包 |
| Agent（Claude Code/Codex/Cherry Studio…） | 环境变量或配置里的 `mk_live_…` | MCP 或 OpenAI 兼容接口 | 花钱，受策略约束 |
| 卖方 | 无需注册 MoneySwitch | x402 | 收 USDC |

## 安全模型与护栏

- **Agent 永远拿不到私钥**，只有一把受预算/白名单/审批约束的 `mk_live_…`
  MoneyKey——和它已经会用的任何其他 API Key 形状一样。
- **策略先于签名**，在同一个数据库事务里完成：单笔上限 → `max_price` 上限
  → 日/总预算 → 审批阈值。所有检查通过之前不会产生任何签名。
- **host 白名单管辖每一次出站请求**，包括免费请求——`POST /v1/fetch` 本
  质上是一个出站代理。空白名单等于全部拒绝。
- **SSRF 防护**：MoneySwitch 永远拒绝 Agent 把请求指回自己的监听地址，覆
  盖常见的字面量形式（`127.0.0.1`/`localhost`/`0.0.0.0`/`::1`）。这是字
  符串/IP 字面量匹配，不是 DNS rebinding 防护——精确边界见
  [SECURITY.md](SECURITY.md)。
- **秘密不会被回显**。完整的 MoneyKey 和 admin token 只在创建时显示一次，
  库里只存 SHA-256 哈希。钱包私钥只在解锁状态下的进程内存里以明文存在，永
  不落盘、永不写日志、永不出现在任何 API 响应里。
- **`unknown` 状态的付款保守地计入已用额度**，而不是在上游结果无法确定
  （超时、断连）时悄悄放过——因为那样有静默超支的风险。需要人工在
  `GET /v1/admin/usage` 里核对。

完整威胁模型：[`docs/security.md`](docs/security.md) /
[`SECURITY.md`](SECURITY.md)。

## Monad 测试网

MoneySwitch 的 x402 客户端与 mock-facilitator 测试套件基于下表这些测试网
事实构建，并作为仓库自带的 `pnpm test:testnet` 的一部分对照真实 RPC 校验
（完整、带日期的版本见 [`SPEC.md`](SPEC.md) §1）：

| | 值 |
|---|---|
| CAIP-2 网络 | `eip155:10143` |
| RPC | `https://testnet-rpc.monad.xyz` |
| USDC（测试网） | `0x534b2f3A21130d7a60830c2Df862319e593943A3`（6 位小数） |
| Facilitator | `https://x402-facilitator.molandak.org` |
| 付款方案 | `exact`（EIP-3009 `transferWithAuthorization`） |

一笔真实结算（非 mock）是指 `paid_fetch`/`/v1/fetch` 产生一个 `tx_hash`，
可独立核实：取该交易的 receipt，核对其中存在匹配的 USDC
`Transfer(from=钱包, to=卖方, value=…)` 日志——见
`tools/m6/verify-transfer.mjs`。MoneySwitch 从不自动给钱包充值或自动领水，
这永远是链下的人工步骤（见 [`docs/quickstart.md`](docs/quickstart.md)）。

截至 2026-09-26，已在 Monad 测试网真实结算 11 笔 x402 付款（非 mock），包括付费 fetch、
openai SDK 对话和一笔经人工审批的付款，全部链上可查；其中 4 笔（首笔、Claude Code 经 MCP、
openai SDK 对话、审批付款）用 [`tools/m6/verify-transfer.mjs`](tools/m6/verify-transfer.mjs) 逐笔核对过 Transfer；Agent 金库不需要
gas（facilitator 为 `exact`/EIP-3009 结算代付 gas），首笔 tx
`0x1c83a45d…4d4d`（区块 65595248）。

## Roadmap

- **v0.1**（已完成）：MoneyKey、策略引擎、本地钱包、x402 客户端、MCP、
  Dashboard、离线测试（T1/T2）与测试网只读校验（T3）。
- **v0.2**（已完成）：OpenAI/NewAPI 兼容网关（`/v1/chat/completions`、`/v1/models`、
  billing 接口）、渠道（Channel）、Playground。
- **v0.3**（当前）：员工端 Dashboard 视图、一键桌面接入
  （`moneyswitch-connect` → npm 包 `moneyswitch`）。
- **下一步**：按 token 计价（x402 `upto`）、MetaMask / OKX 钱包驱动、
  多用户组织（部门额度、审批流）。
- 明确不做（完整列表与原因见 [`SPEC.md`](SPEC.md) §12）：导入钱包插件私
  钥、默认开启主网、法币出入金。

## License

MoneySwitch 按组件分层许可：Agent 或卖方**嵌入自己进程**的部分是宽松许可，
自托管服务器保持 copyleft，让托管分叉的改进能回馈社区。

| 组件 | 许可证 |
|---|---|
| `apps/mcp`、`apps/connect`、`apps/cli`（npm 包 `moneyswitch`）——客户端代码 | [Apache-2.0](apps/mcp/LICENSE) |
| `apps/demo-seller`（x402 卖方示例） | [Apache-2.0](apps/demo-seller/LICENSE) |
| 其余全部（`apps/server`、`apps/dashboard`、`packages/*`） | [AGPL-3.0-only](LICENSE) |

需要在闭源产品中嵌入 server，请开 issue 讨论商业许可。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献需要同意
[CLA.md](CLA.md)（以便项目能继续提供上面的双许可条款）。请先阅读
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
