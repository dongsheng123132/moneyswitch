# Monad Metropolis 提交材料（草稿，提交前由用户过目）

## 项目名
MoneySwitch

## 一句话（Tagline）
Give your AI an API key for money — x402 USDC payments on Monad, plug-and-play.
中文：让 AI 花钱，像用 API Key 一样。x402，即插即用。

## 赛道与赏金（平台已选，2026-09-27）
主赛道：Trust, Identity & AI Infrastructure（Track 04 —— 给其他应用用的基础设施，不是独立 C 端产品）
赏金：Mera: One Passkey, Many Keys · Best use of Nansen · Best Builds with Qwen 3.8 Max
截止：2026-10-14 11:59 GMT+8（10-02 开放提交）

## 简介（短，~300 字符）
x402 lets AI agents pay per request in USDC, but using it today means putting a private key inside every agent and wiring 402 / EIP-3009 / facilitators by hand. MoneySwitch turns it into something everyone already knows: an API key. Agents get a revocable `mk_live_` MoneyKey with budgets, per-request limits and human approval; MoneySwitch checks policy before signing and settles in USDC on Monad. Works with any OpenAI/NewAPI client, MCP (Claude Code, Codex) and a one-click desktop console. Sellers can put a toll booth in front of any API to get paid — no secrets, just a public address.

## 详细描述
**Problem.** AI agents can already pay via x402, but people don't dare hand a wallet to an agent: today's x402 client examples put `PRIVATE_KEY=0x…` straight into the program, and budgets, revocation, audit and multi-agent spending all have to be hand-built.

**Solution — x402, plug-and-play.**
- **MoneyKey (`mk_live_…`)**: an API key for money. Not money, not a private key — a revocable spending permission with daily/total budgets, per-request limit, host/model allowlist and an approval threshold. Policy runs *before* signing, inside one database transaction.
- **Feels like NewAPI + CCSwitch**: issue keys, set quotas, watch usage like token usage (Dashboard); one switch per agent to enable it (desktop console `npx moneyswitch ui`, model "brain" + MoneyKey "wallet" per agent, diff-preview before writing configs).
- **Drop-in compatible**: OpenAI/NewAPI-compatible gateway (`Base URL` + `mk_live_` key works in openai SDK, Cherry Studio, Open WebUI), MCP server for Claude Code / Codex, REST `/v1/fetch`.
- **Multi-level child keys**: company → employee → each agent; a child can never exceed its parent; every payment is checked along the whole ancestor chain; revoking cascades.
- **Receiving: toll booth**: put a toll booth in front of any API (`npx moneyswitch sell --upstream … --price 0.01 --pay-to 0x…`); AI pays USDC via x402 before it passes; upstream errors are never charged. Sellers need no secret — only a public receiving address.
- **Safety UX for normal people**: "three things" everywhere — private key (never shown), MoneyKey (secret), receiving address (public) — with paste guards that block putting a MoneyKey into an address field.

**Built on existing rails, no new protocol or token**: official x402 SDK (`@x402/*`), Monad, Circle USDC, Monad's x402 facilitator.

**Proof on Monad mainnet** (real money): an agent's MoneyKey (scoped to api.nansen.ai, $0.01/request, $0.03 total) bought Nansen's Token Screener for Monad over x402 — 0.01 USDC settled on Monad mainnet (tx 0x98297ba48601af6b2acc032f280db1c292de1071c754921d24a27464e3ce5e9c, block 108465232), gas paid by the Molandak facilitator.

**Proof on Monad testnet** (all on-chain): 12 real x402 USDC settlements, 0 mock — including Claude Code paying by itself via MCP (tx 0x1cdf773ecc03c84f3aabaa8b4426fb6d4fd2cfd1c87e77cb8869cd2870dc2729), an admin-approved payment (0x7f599d6831f269f58f28726fe2c88f7a2d115636b5ca323ac4ab423b6b08e165), an OpenAI-SDK chat paid per message (0xd3697cadea90194c9878f5584d7d22eeb5d877b94006da76021cfb539f9680ad) and a toll booth purchase (0x6239ce7d620807ae8a6963ab3b84b1d53c6ab6b8009cdc9da608c0e92742d38c). The agent vault needs 0 MON — the facilitator pays gas. 300+ automated tests.

**Try it**: `npx moneyswitch demo` (offline, simulated) · self-host `npx moneyswitch-server` · `npx moneyswitch sell / ui / connect`.

## 链接
- GitHub: https://github.com/dongsheng123132/moneyswitch
- 官网: https://moneyswitch.dev （DNS 生效前用 https://dongsheng123132.github.io/moneyswitch/）
- npm: https://www.npmjs.com/package/moneyswitch
- 演示视频: https://github.com/dongsheng123132/moneyswitch/releases （v0.5.1 Release 附 89 秒视频；v0.4.0 已附 70 秒版）
- Pitch deck PDF: 同 Release 附件

## 技术栈
TypeScript · Fastify · React/Vite · SQLite (better-sqlite3, Drizzle) · viem · x402 official SDK (@x402/core, @x402/evm, @x402/fetch, @x402/express) · MCP SDK · Monad testnet (eip155:10143) · Circle USDC

## 许可证
接入层（CLI、MCP、connect、收费站、卖方示例）Apache-2.0；服务端与 Dashboard AGPL-3.0。
