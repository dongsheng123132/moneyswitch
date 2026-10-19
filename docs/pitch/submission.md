# Monad Metropolis 提交材料（v0.7 草稿，提交前由用户过目）

> 按 v0.7（SPEC.md）重写，2026-10-04。旧版备份：`.data/archive-20261004/submission.md.before-v07`。
> 标 **【待你】** 的地方需要你操作或拍板。

## 项目名
MoneySwitch

## 一句话（Tagline）
Give your AI agent an API key for money: it pays x402 APIs in USDC within the budget you set, asks you before big payments, and never touches a private key. Open source, self-hosted, on Monad.

中文：给 AI 一把"花钱的 API Key"——在你设的额度内用 USDC 付 x402 接口，大额先问你，永远拿不到私钥。开源、自己部署、跑在 Monad 上。

## 赛道与赏金
- 主赛道：Track 04 — Trust, Identity & AI Infrastructure（给其他应用用的基础设施）。
- 赏金：Best use of Nansen；Best Builds with Qwen 3.8 Max。两项都有真实使用记录（见下方"主网证据"）。
- **【待你】** 平台上目前还勾着 "Mera: One Passkey, Many Keys"。我们没有做 Mera 集成，按"不为赏金做功能"的原则，建议取消这一项。
- 截止：2026-10-14 11:59 GMT+8。

## 简介（短，约 300 字符）
x402 lets AI agents pay per request in USDC, but nobody wants to hand an agent a private key. MoneySwitch is a small self-hosted server: it keeps one small "float" wallet, gives every agent its own revocable MoneyKey with budgets and an approval threshold, and pays x402 sellers on Monad on the agent's behalf. Connecting an agent means pasting one block of text.

## 详细描述

**Problem.** x402 lets an AI agent pay for an API call in USDC, per request. The basic examples put a private key inside the agent. Hosted agent wallets fix that for one person on one platform. A team that wants to give many agents a budget, approve large payments and keep the keys and the ledger on its own server has to build that itself.

**What MoneySwitch is: three things.**
1. **Wallet.** One small float wallet on your own server. Created with one click; the 12-word recovery phrase is shown once (it restores the same address in MetaMask or OKX); it unlocks itself after a restart; it can be replaced if anything goes wrong, and old keys are archived, never deleted.
2. **Keys.** One MoneyKey (`mk_live_…`) per agent: daily and total budget, per-request limit, allowed hosts, approval threshold, expiry. Revocable and resettable at any time. It is a spending permission, not money and not a private key.
3. **Payment.** One endpoint, `POST /v1/fetch`, plus a skill: a block of text you paste into Claude Code, Codex or OpenClaw. Above the approval threshold the agent receives an approval link and sends it to its human; approving requires the admin's login, so an agent cannot approve itself.

**Why it can be trusted (the Track 04 part).**
- The policy is checked before anything is signed, in one database transaction.
- Every answer says whether money moved: `charged: yes | no | maybe`. A payment whose outcome is unknown is never retried automatically, and the transaction hash is filled in later from the chain.
- Only EIP-3009 USDC authorizations are signed (no Permit2), and the facilitator pays the gas, so the wallet needs no MON.
- The wallet's unlock secret is readable only by the service's own user (Windows ACL, POSIX 0700/0600). Three independent security reviews were run on the wallet code before the v0.7.0 release.
- The product is deliberately small: four admin pages (Wallet, Keys, Approvals, Bills), 26 HTTP routes, each one pinned by a route-inventory test.

**How it differs.** Hosted agent wallets (Coinbase Payments MCP, AWS AgentCore Payments, MetaMask Agent Wallet, Circle Agent Wallets) give one person's agent a wallet on their platform. MoneySwitch is the open-source, self-hosted policy and ledger layer for a team's agents: no platform account, keys and ledger on your own server, Monad-native.

**The 10-minute path (our acceptance test).** A new user creates the wallet, funds it from the faucet, issues a key, and pastes the skill into an AI; the AI pays the public test endpoint and reports the transaction. On 2026-10-04 a fresh agent that received nothing but the pasted text did exactly that on Monad testnet: tx `0x10c4d61ca56ff9f45806d80b064ffee3f84a5e29348c365c4426b3b8151ebad3`.

**Proof on Monad mainnet (real money).**
- An agent's MoneyKey bought Nansen's Token Screener for Monad over x402: 0.01 USDC, tx `0x98297ba48601af6b2acc032f280db1c292de1071c754921d24a27464e3ce5e9c` (block 108465232). The Monad facilitator paid the gas.
- A Qwen 3.8 Max research agent planned against a $0.09 budget and bought 5 Nansen queries by itself: three screeners, one flow check and one premium smart-money netflow (for example tx `0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6`). All five were verified on chain.

**Proof on Monad testnet (2026-10-04, v0.7.0).**
- Approval-link flow: the payment was above the key's approval threshold, so the agent got an approval link; its own key could not approve (403) and neither could an unauthenticated request; the admin approved; the agent then paid exactly once, and reusing the same approval was refused: tx `0x59e69aedf742e056c48288a7cae80364042497f5082907e41c733110294a61cf`.
- Fresh agent, install and first payment: tx `0x10c4d61ca56ff9f45806d80b064ffee3f84a5e29348c365c4426b3b8151ebad3`.

## 链接
- 在线产品（测试网）：https://app.moneyswitch.dev
- 官网：https://moneyswitch.dev
- GitHub：https://github.com/dongsheng123132/moneyswitch （发行版 v0.7.0）
- 演示视频（≤3 分钟）：**【待做】**
- 团队介绍视频（≤2 分钟）：**【待做】**

## 评委账号
评委拿到两样东西，都只放在提交表单的**评委凭证（私密）栏**，不公开发布：

1. **后台管理员令牌**：登录 https://app.moneyswitch.dev 看钱包、Key、审批、账单，也能亲手批准一笔审批。
2. **两段"技能"文本**（各带一把测试网 MoneyKey），粘贴给自己的 Claude Code 或 Codex：
   - "Judges"：AI 直接付 0.01 测试 USDC 给公开测试接口，并给出交易号。
   - "Judges (approval)"：每笔都要审批。AI 会给出一个审批链接，评委用上面的管理员令牌登录批准，AI 才会付款。

这个实例只开测试网，钱包里只有测试币（现有 20 个，够约 2000 次测试付款）。

**【待你】**
- 在 Key 页发两把 key（发出后额度不能改，所以一次给够）：
  - "Judges"：总额 2、每日 2、单笔 0.01，勾选"允许付款测试接口"；
  - "Judges (approval)"：总额 1、每日 1、单笔 0.01、审批线 0.005，勾选"允许付款测试接口"。
- 把管理员令牌和两段话填进评委凭证栏。
- 评审结束后：在服务器上运行重置命令换掉管理员令牌，并撤销这两把 key。

```bash
ssh siliconvalley "docker exec moneyswitch-server-1 node /app/dist/cli.js reset-admin-token"
```

## 技术栈
TypeScript · Fastify · React/Vite · SQLite (better-sqlite3) · official x402 SDK (@x402/core, @x402/evm, @x402/fetch) · ethers/viem · Monad mainnet (eip155:143) and testnet (eip155:10143), Base (eip155:8453 / 84532) · Circle USDC (EIP-3009) · Docker + Caddy

## 许可证
服务端、核心与后台：AGPL-3.0-only。给 AI 的技能包、网络与代理包、测试卖家和示例：Apache-2.0。
