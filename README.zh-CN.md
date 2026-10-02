# MoneySwitch

[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2F%20Apache--2.0-blue)](#license)
[![CI](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/moneyswitch)](https://www.npmjs.com/package/moneyswitch)

**给你的 AI 一把花钱的 API Key。**

官网：[moneyswitch.dev](https://moneyswitch.dev) · [English →](README.md)

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

**先试玩——完全离线，不动真钱**（需要 Node.js 22+）：

```bash
npx moneyswitch demo
```

会在本机空闲端口起一个临时的 MoneySwitch：模拟钱包、一个演示 LLM 渠道、两把
MoneyKey（「Claude Code」「Codex」）、挡在演示 API 前面的一个收费站，外加几笔
演示流水，并自动打开已登录的 Dashboard。在 Playground 发一条消息（$0.01），
试着买一次 $5 的报告看它被单笔上限拦下，再去看收费站收入。所有界面都标着
**DEMO · 模拟结算**，结算走本地 mock facilitator，不上任何链。Ctrl+C 即停止并
删除全部数据。（`moneyswitch demo` 会下载独立的 `moneyswitch-server` 包，许可
证为 AGPL-3.0-only；如果你的 npm 镜像源还没同步到它，加上
`--registry=https://registry.npmjs.org/`。）

**一条命令自托管服务端 + Dashboard**：

```bash
npx moneyswitch-server            # http://127.0.0.1:4020，数据在 ~/.moneyswitch/server
```

首次启动会打印一条一次性设置链接（`http://127.0.0.1:4020/setup#ms_setup_…`），
打开即登录，并带你走完 钱包 → 渠道 → 第一把 Key → 接入 Agent。可用
`--data-dir`、`--port`、`--host` 改默认值。

**让 AI Agent 学会付费——粘贴一次就行。** 在 Dashboard 里新建一把 MoneyKey
（一个 Agent 一把，用 Agent 的名字命名：`Codex`、`OpenClaw`……），点
**交给你的 AI**，选好 Agent 后复制，粘贴给 Codex、Claude Code、OpenClaw、
Hermes 或任何读取 `SKILL.md` 的 Agent。这段文字是一句安装说明加一个
`moneyswitch-pay` skill，里面有本服务器的地址和**该 Agent 自己的** MoneyKey；
Agent 把它存成 skill、汇报剩余额度，之后遇到 x402（HTTP 402）接口就会通过
`POST /v1/fetch` 付费。key 找不到了？key 只存哈希，请在 key 列表点
**重置密钥并复制 skill**（旧密钥立刻失效，额度和历史不变）。Dashboard 的「接入
Agent」页和员工端也有同一段文字；`GET /skill.md` 提供本服务器的通用 skill（不含 key）。
文字由同一个渲染器（`packages/skill`）生成，
[`skills/moneyswitch-pay/SKILL.md`](skills/moneyswitch-pay/SKILL.md) 是它的
通用版本，从环境变量 `MONEY_API_BASE`、`MONEY_API_KEY` 读取地址和 key。

**进阶：不用 skill，改在本机接 MCP**（用一把 MoneyKey）：

```bash
npx moneyswitch connect --server http://127.0.0.1:4020 --key mk_live_xxx --apply
```

这条命令会探测本机的 Claude Code / Codex 并自动接好 MoneySwitch 的 MCP
服务器（不带 `--apply` 时只打印打算做的改动）。`npx moneyswitch status --server … --key …`
查一把 Key 的剩余额度；`npx moneyswitch remove --apply` 撤销接入；
`npx moneyswitch ui` 打开本机桌面控制台。Dashboard 的「接入 Agent」页和
「发给员工」消息会用正确的服务器地址生成这些命令。

**让 AI 为你自己的 API 付钱**（不需要服务器）：

```bash
npx moneyswitch sell --upstream http://localhost:8000 --price 0.01 --pay-to 0x你的公开收款地址
```

从源码运行（贡献者）：

```bash
pnpm install
pnpm build
pnpm demo:local
```

`pnpm demo:local` 会用仓库代码同时起一个离线 mock 的 x402 facilitator、一个
demo x402 卖方、和带 Dashboard 界面的 MoneySwitch 服务器——全程离线，不会发生
真实付款。真实 Monad 测试网路径（`pnpm demo:testnet`）与手动分步版本见
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

## 四种接入方式

1. **Skill（推荐）**——粘贴一次，Agent 就得到带有本服务器地址和它自己
   MoneyKey 的 `moneyswitch-pay` skill（Agent Skills 的 `SKILL.md`）。
   Dashboard：*Money Keys → 交给你的 AI*。不需要 MCP 和配置文件，Agent 直接调下面的
   REST 接口。文字只在 `packages/skill` 里生成一份；`GET /skill.md` 提供通用版本。
2. **MCP**（`apps/mcp`，stdio）——`money_status`、`paid_fetch`、
   `money_history` 三个工具。`npx moneyswitch mcp`，或用 `moneyswitch
   connect --apply` 自动接入 Claude Code / Codex。见
   [`docs/claude.md`](docs/claude.md)、[`docs/codex.md`](docs/codex.md)。
3. **OpenAI / NewAPI 兼容网关**——在任意支持 OpenAI SDK 协议的客户端
   （openai SDK、Cherry Studio、Open WebUI、NewAPI 上游渠道）里填
   `Base URL = http://<server>/v1`、`API Key = mk_live_xxx`。已实现
   `GET /v1/models`、`POST /v1/chat/completions` 与旧版 OpenAI billing 接
   口——见 [`SPEC-v0.2.md`](SPEC-v0.2.md) 与
   [`docs/money-api-v0.md`](docs/money-api-v0.md)。
4. **REST**——`POST /v1/fetch { url, method?, headers?, body?, max_price? }`
   直接通过策略引擎请求任意 x402 收费 URL。见
   [`docs/money-api-v0.md`](docs/money-api-v0.md)。

## 收款：收费站（v0.5）

MoneySwitch 也能**收钱**。在你已经在跑的 API 前面立一个「收费站」：AI
每次调用用 x402 付 USDC，钱直接进你的收款地址，Dashboard 像看营收一样看
收入。**卖东西不需要任何秘密，只需要一个公开的收款地址；你的服务一行代码
都不用改。**

### 三样东西（先看这个）

| 东西 | 比喻 | 给谁 | 在 MoneySwitch 里 |
|---|---|---|---|
| 私钥 | 保险柜钥匙 | **谁都不给** | 任何地方都不显示；它只（以解密状态）待在服务器内存里 |
| MoneyKey `mk_live_…` | 给员工的限额副卡 | **只给你自己的 AI** | 🔒 琥珀色，「保密：拿到它的人能在额度内花你的钱，不要发给卖家」 |
| 收款地址 `0x…` | 收款码 | **可以给任何人** | ✅ 绿色，「公开：别人付钱给你用它，可以放心分享」 |

在任何「收款地址」输入框里粘贴 MoneyKey、管理员口令、私钥或助记词，都会
被拦截并解释（服务端同样以 `INVALID_PAY_TO` 拒绝）；在 Key 输入框里粘贴
`0x…` 地址也会被拦截。收款地址默认就是本 MoneySwitch 的钱包（一个钱包，
收付一体）；也可以改成你自己控制的任意地址（比如冷钱包）——那样
MoneySwitch 就无法替你花这笔钱。

### 在 Dashboard 里

「收费站 → 新建收费站」：① 把哪个服务挂出去（`http://127.0.0.1:8000`，
可免费「测试连接」）② 怎么收费（模板：「整个服务每次 $0.01」
「`/v1/chat/completions` 每次 $0.01，其余免费」……；规则写成 `方法 /路径`
或 `/前缀/*`，越具体越优先；没匹配到任何规则的路径可以按默认价收费、免费
放行或直接拒绝）③ 钱进哪里。完成后得到一个公开调用地址
`https://<server>/t/<slug>/…` 给买家，外加现成的买家调用示例。「收入」页
按今天 / 7 天 / 全部、按收费站和规则汇总，列出每一笔（付款地址、路由、
金额、交易、上游状态），可导出 CSV。

```bash
# 任何人：402 + 价格 + pay_to
curl -i http://127.0.0.1:4020/t/weather/v1/today
# 买家，用「他自己的」MoneyKey
curl -s http://127.0.0.1:4020/v1/fetch \
  -H "Authorization: Bearer mk_live_xxx" -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:4020/t/weather/v1/today"}'
```

挂在收费站后面的 OpenAI 兼容服务，可以直接作为别人 MoneySwitch 里的一个
「渠道」（`Base URL = https://<server>/t/<slug>/v1`）。

**只有你的服务返回 2xx/3xx，买家才会被扣钱。** 先验证付款、再转发请求、
成功才结算；上游 4xx/5xx/超时则取消这笔付款，记为「未扣款」。你的上游会
收到 `X-MoneySwitch-Payer`、`X-MoneySwitch-Amount`、
`X-MoneySwitch-Tollbooth`，绝不会收到买家的 `Authorization`/`Cookie` 或付
款头。只需要让买家访问得到 `/t/*`——管理 API 和 Dashboard 仍然不要对外
（见 [`docs/security.md`](docs/security.md)）；用 `MONEYSWITCH_PUBLIC_URL`
设置买家使用的公网地址。接口细节见
[`docs/money-api-v0.md`](docs/money-api-v0.md#toll-booths-v05-spec-v05-2)。

### 不开服务器：`moneyswitch sell`

```bash
npx moneyswitch sell \
  --upstream http://localhost:8000 --price 0.01 --pay-to 0x你的公开收款地址 \
  --route "POST /v1/chat/completions=0.02" --route "GET /health=0"
```

本机单进程收费站（官方 `@x402/express`），和服务端收费站共用同一套规则
匹配与转发代码。启动时打印公开调用地址和你的（公开）收款地址；把
MoneyKey 或私钥当 `--pay-to` 会被直接拒绝。

## 角色

| 角色 | 拿什么 | 在哪用 | 能做什么 |
|---|---|---|---|
| 管理员（老板/财务） | `ms_admin_…` | Dashboard | 钱包、渠道、给每个 Agent 开/收 Key、审批、看全公司用量 |
| 员工 | 一把或几把 `mk_live_…` | Dashboard「我的额度」视图 + 桌面 CLI | 看自己额度/流水、Playground、一键把 Key 配进本机 Agent；不能看别人、不能碰钱包 |
| Agent（Claude Code/Codex/Cherry Studio…） | 环境变量或配置里的 `mk_live_…` | MCP 或 OpenAI 兼容接口 | 花钱，受策略约束 |
| 卖方 | 只要一个**公开**收款地址 `0x…`（不需要任何秘密） | MoneySwitch 收费站、`moneyswitch sell` 或任意 x402 服务 | 收 USDC；用收费站还能在「收入」页看账 |

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

## 在代理后面使用（Clash / v2rayN）

如果出站 HTTPS（facilitator、RPC、卖方，例如某个 `*.vercel.app` 域名）因为你在
大陆/公司网络的代理后面而超时，server 和 CLI（`sell`/`demo`）会自动探测代理并
让所有出站 `fetch` 走它，不需要改代码。解析优先级：

1. `MONEYSWITCH_PROXY`——`"off"`（永远不代理）、`"auto"`（默认）、或一个具体的
   代理 URL（`http://127.0.0.1:7897`，或裸 `127.0.0.1:7897`）。
2. 标准的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写都认）。
3. 仅 Windows：系统代理开关（设置 → 网络 → 代理；Clash Verge/v2rayN 帮你打开的
   就是这个）。

`localhost`、loopback、以及私网/CGNAT 网段（`10/8`、`172.16/12`、`192.168/16`、
`100.64/10`）永远直连——这样收费站自己的 `--upstream`、本机 MoneySwitch 自身、
以及局域网里的其他服务，即使装了代理也照样可达；`NO_PROXY`/`no_proxy`（在
Windows 上还有代理的例外名单）会在此基础上追加更多直连的主机。Server 启动时会
打印它选中的来源（`outbound proxy: http://127.0.0.1:7897 (source:
windows-system)`，或 `outbound proxy: none (direct)`），并在
`GET /v1/admin/meta` 的 `outbound_proxy` 字段里暴露 `host:port` + 来源（不含
认证信息）。

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
- **v0.3**（已完成）：员工端 Dashboard 视图、一键桌面接入
  （`moneyswitch-connect` → npm 包 `moneyswitch`）。
- **v0.4**（已完成）：子 Key（多级分配）与本机桌面控制台（`moneyswitch ui`）。
- **v0.5**（已完成）：收费站——让任何 API 向 AI 收 USDC（`/t/<slug>`、收入页、`moneyswitch sell`）；
  v0.5.1：`npx moneyswitch demo`（离线试玩）与 `npx moneyswitch-server`（一条命令自托管）。
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
| `apps/server-pkg`（npm 包 `moneyswitch-server`：为 `npx` 打包好的服务端 + Dashboard） | [AGPL-3.0-only](apps/server-pkg/LICENSE) |
| `apps/demo-seller`（x402 卖方示例） | [Apache-2.0](apps/demo-seller/LICENSE) |
| `packages/skill` 与 `skills/`（粘贴给 Agent 的 skill 文字及其渲染器） | [Apache-2.0](packages/skill/LICENSE) |
| `packages/tollbooth`（收费站规则匹配、转发、收款地址校验——服务端与 `moneyswitch sell` 共用） | [Apache-2.0](packages/tollbooth/LICENSE) |
| 其余全部（`apps/server`、`apps/dashboard`、其余 `packages/*`） | [AGPL-3.0-only](LICENSE) |

两个 npm 包分别发布：`moneyswitch`（Apache-2.0）里没有任何服务端代码；
`moneyswitch demo` 只是通过 `npx` 以独立进程**运行** `moneyswitch-server`（AGPL-3.0-only）。

需要在闭源产品中嵌入 server，请开 issue 讨论商业许可。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献需要同意
[CLA.md](CLA.md)（以便项目能继续提供上面的双许可条款）。请先阅读
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
