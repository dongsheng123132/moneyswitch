# MoneySwitch v0.6 — 收窄范围（权威版）

> 2026-10-02 用户拍板。与 SPEC.md ~ SPEC-v0.5.md 冲突时以本文件为准。
> 初心不变（SPEC.md §0）：让 AI 像用 API Key 一样用钱；AI 永远拿不到私钥；只用现成的轨道（x402、USDC），不发币、不造协议。

## 0. 一句话

企业（或个人）自建一台 MoneySwitch：往钱包里放 USDC，给每个员工、每个 AI 发一把有规则的 MoneyKey。
AI 拿到「一段技能 + 一把 key」就能付任何 x402 服务；超过审批线找人批；每笔都有链上凭证。**只做买方。**

## 1. 做什么

| 部分 | 内容 |
|---|---|
| 服务端 | 不带界面也能跑；管理后台 + 员工门户由同一端口提供 |
| MoneyKey | 日/总预算、单笔上限、域名白名单、审批线、过期、子 key；**重置密钥**（库里只存哈希，原文只在创建/重置时出现一次） |
| 付款接口 | `POST /v1/fetch`；OpenAI 兼容网关 `/v1/chat/completions`（付给 x402 模型卖家，也是 new-api 接入的入口） |
| 接入 AI | **首选：技能 + key**（粘贴一段话，AI 自己存成技能）。备选：MCP、OpenAI Base URL |
| 审批 | 超过审批线 → 推送（飞书 / 企业微信 / Telegram / 通用 webhook）→ 人在后台批 → AI 带 `approval_id` 重发；AI 可用 `GET /v1/approvals/:id` 查进度 |
| 扣款诚实 | 每次返回带 `charged: yes/no/maybe`；签了名但结果不明 → `payment_unknown`，AI 不得自动重试 |
| 多链 | **支持多链，不做跨链、不做兑换**：同一个钱包地址在每条链上各自持有 USDC，卖家收哪条链就在哪条链付。顺序：Monad → Base → 其他。链做成配置表（CAIP-2），不写死任何一条 |
| 部署 | 服务器优先（Docker + HTTPS 反代）；本机自用同样支持 |

### 多链的已核实事实（2026-10-02）
- 官方 x402 SDK `@x402/evm@2.27.0` 内置网络表里有 Monad 主网 `eip155:143`、Base `eip155:8453`、Base Sepolia `eip155:84532`、Polygon `eip155:137` 等；**没有 BSC（`eip155:56`）**。
- BSC 上的 USDC（`0x8AC7…580d`）和 USDT（`0x55d3…7955`）链上实测：`authorizationState`（EIP-3009）和 `nonces`（EIP-2612）都 revert。x402 默认的免 gas 签名付款在 BSC 走不通，只能走 Permit2（需先发一笔 approve，付 BNB gas），而且要有支持 BSC 的 facilitator 和卖家。→ BSC 等有真实卖家再做。

## 2. 删除（本轮）

- **收费站 / 卖方功能**：`packages/tollbooth`、`/t/*`、`/v1/tollbooths*`、收益页、`moneyswitch sell`。删除前打存档 tag `archive/tollbooth-v0.5`，以后要做收款可另立产品。
  - 旧数据库里的表**不 DROP**，只是不再读写。
  - `apps/demo-seller` 保留，仅作测试和演示用的卖家；原来借用自家收费站当假卖家的测试改用它。
  - 粘贴防呆（地址 / MoneyKey / 私钥形状检查）是买方也要的，搬到保留的包里。
- **本机的壳**：`moneyswitch ui`（本机控制台）和 `moneyswitch connect`（往 AI 配置文件里写东西）。本机使用 = 把技能 + key 粘贴给 AI，不再装任何东西。

## 3. 永不做

法币出入金（含「法币买 USDC」和第三方代卖 key）、swap、跨链桥、发币、自造协议、替别人保管钱对外营业。

## 4. 不归本仓库管

AgentVerse、灵签、灯城、服务市场索引是独立的试用场，不在这里开发。`apps/qwen-agent` 原样保留为示例，不再投入。

## 5. 安全前提（沿用 SPEC.md §13）

AI 和 MoneySwitch 在同一台机器、同一个系统用户下运行时，能执行命令的 AI 可以直接改数据库、绕过额度。
企业用法：MoneySwitch 部署在独立的服务器或容器里，AI 只拿 key 远程调用。
