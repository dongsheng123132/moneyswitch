# MoneySwitch 推广发布工具箱（2026-10-15）

> 用法：一份文件汇总全部对外发布物料，按渠道分节，均为可直接复制发送的成稿。
> 原则延续 `outreach-2026-10.md`：只走公开渠道（Discord、GitHub、官网联系方式），发布前你过目、由你发送。
> 比赛时间线：评审窗口 **10/14–10/27**，结果 **11/03** 公布（当前正处于评审期）。
> 素材路径相对 `C:\1mineyswitch`。

---

## 0. 发布总览与待你确认清单

| 渠道 | 建议时间 | 状态 |
|---|---|---|
| Monad Discord + 生态社区 | 10/15–10/18 | 文案见 B，可发 |
| X / Twitter 线程 | 10/16 | 文案见 A，可发 |
| 即刻 / V2EX / 掘金 | 10/16–10/22 | 文案见 C，可发 |
| 生态目录提交（agentpaymentsstack / awesome-x402 / agent402.tools） | 10/15–10/24 | 内容见 E，**PR 待你点头** |
| Show HN + dev.to 技术长文 | 10/22–10/27 | 提纲见 F |
| Product Hunt | 11/4–11/6（周二–周四） | 包见 D，**需 PH 账号 + hunter** |

**【待你】项（逐项打勾）：**
- [ ] **比赛是否已正式提交**（截止 10/13–14；若未提交请立即联系组委会说明评审期仍在进行）
- [ ] 评委凭证（管理员令牌 + 两把 key）是否已填进提交表单——这是「请评委 2 分钟试用」的前提
- [x] awesome-x402 PR 已提交（10/15，PR #1837：https://github.com/xpaysh/awesome-x402/pull/1837）
- [ ] Product Hunt：有无账号 + hunter（没有就用「发布当天自荐」，或赛后找 Monad 社区 hunter）
- [ ] X / Discord / 即刻 分别用哪个账号发

---

## A. X / Twitter 线程（英文，10/16 发）

> 配图：每条约 1 张帧图或截图；末尾挂 v3 视频（`docs/pitch/video/moneyswitch-pitch-v3-share.mp4`）。
> 账号建议 @monad_xyz @x402 @Nansen_ @CoinbaseDev（按实际名号核对）。

**Tweet 1（钩子，配 frame-01）**
Give your AI agent an *API key for money* — not your private key.
MoneySwitch is a self-hosted server that lets agents pay x402 APIs in USDC, within the budget you set. Built for @monad_xyz's Metropolis, Track 04. 🧵

**Tweet 2（问题，配 frame-05）**
x402 lets an agent pay for an API call, per request. But nobody wants to hand an agent a private key.
Hosted agent wallets fix that for one person on one platform. A team that wants budgets, approvals and its own ledger has to build it from scratch. We didn't want to.

**Tweet 3（产品，配 frame-09 或 dashboard-desktop.png）**
MoneySwitch = 4 admin pages (Wallet, Keys, Approvals, Bills), 26 HTTP routes.
Every agent gets a revocable MoneyKey: daily & total budget, per-request limit, allowed hosts, approval threshold, expiry.
One rule: one MoneySwitch spends money for exactly one payer. Not custody — infrastructure.

**Tweet 4（信任，配 live-pin-desktop.png）**
Payments above a threshold need a human. The human approves with a 4–6 digit PIN — an agent can never approve itself.
Every answer says `charged: yes / no / maybe`. A payment whose outcome is unknown is never retried automatically. Honest money.

**Tweet 5（主网证据，配 frame-10）**
Real money, Monad mainnet: an agent's MoneyKey bought Nansen's Token Screener over x402 — 0.01 USDC.
tx `0x98297ba48601af6b2acc032f280db1c292de1071c754921d24a27464e3ce5e9c` · the Monad facilitator paid the gas.

**Tweet 6（主网证据 2，配 frame-14）**
A Qwen 3.8 Max research agent planned against a $0.09 budget and bought 5 Nansen queries by itself — three screeners, one flow check, one premium netflow.
All five verified on-chain. Example tx `0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6`.

**Tweet 7（试用 CTA，配 video）**
Try it on Monad testnet in ~2 minutes: paste one block of text into Claude Code or Codex. The agent pays 0.01 test USDC and shows you the tx.
Live: app.moneyswitch.dev · Code: github.com/dongsheng123132/moneyswitch (v0.7.6) · Open source, self-hosted. 🎬

**Tweet 8（求反馈，收尾）**
We'd love your read on three things:
1. Is "one instance = one payer" the right boundary for agent-payment infrastructure?
2. What do you need before letting an agent spend real money?
3. Which x402 services should agents buy first?
Answers get a demo. 🙏

---

## B. Monad Discord + 生态社区帖子（英文，10/15–10/18）

> 走 Monad Discord 的 builder / hackathon 频道、x402 相关频道。发布前填 `<ADMIN_TOKEN>`。

**MoneySwitch v0.7 — give your AI an API key for money. Try it on Monad testnet (~2 min).**

MoneySwitch is a small self-hosted server that lets AI agents pay x402 APIs in USDC without ever holding a private key. Each agent gets its own budget-limited MoneyKey; payments above a threshold need a human's approval; every payment has an on-chain receipt. Built for Monad Metropolis (Track 04).

One rule decides the product: **one MoneySwitch spends money for exactly one payer** — you, or your company. No sign-ups, no deposits from strangers. That would be custody, not infrastructure.

**This week (v0.7):**
- Cut to the core: 4 admin pages (Wallet, Keys, Approvals, Bills), 26 HTTP routes.
- Connecting an agent = pasting one block of text into Claude Code, Codex or OpenClaw.
- A wallet you can't lock yourself out of: one-click creation, recovery phrase shown once, auto-unlock, safe replacement. Three independent security reviews.
- Honest money: every answer says `charged: yes / no / maybe`; unknown outcomes are never retried automatically.
- Real money proof: an agent's key bought Nansen's Token Screener on Monad mainnet over x402 (tx `0x98297ba4…e5e9c`); a Qwen 3.8 Max research agent bought 5 Nansen queries against a $0.09 budget, all verified on-chain.

**Try it — public TEST server (Monad testnet, test USDC, no value):**
1. Open https://app.moneyswitch.dev, sign in with admin token: `<ADMIN_TOKEN>`
2. Keys → create a key (e.g. total 0.1, per request 0.01), keep "allow the test payment endpoint" ticked.
3. Copy the text the page gives you and paste it into Claude Code or Codex. Your agent pays 0.01 test USDC and shows you the transaction.
4. Want the approval flow? Create another key with approval threshold 0.005 — the agent hands you a link, you approve, it pays.
5. Look at Bills: every payment with its on-chain transaction.

Please be kind to the shared test wallet; the token will be rotated after judging.

We'd value your opinion on three things: is "one instance = one payer" the right boundary? What would you need before letting an agent spend real money? Which x402 services (Monad or Base) would you want agents to buy first?

Code: https://github.com/dongsheng123132/moneyswitch · Website: https://moneyswitch.dev

---

## C. 中文社区帖子（即刻 / V2EX / 掘金，10/16–10/22）

### C1. 即刻（短，口语化）
**给 AI 一把"花钱的 API Key"——它替你付钱，但永远拿不到私钥。**

做了个小服务 MoneySwitch：自己部署，AI 用 USDC 付 x402 接口，每把 key 有额度、大额先问你、每笔有链上凭证。接 Claude Code / Codex 只要粘贴一段话。

主网真金白银试过了：agent 自己拿 0.01 USDC 买了 Nansen 的 Monad 数据，链上可查。测试网 2 分钟能上手，欢迎来玩 👉 app.moneyswitch.dev（目前 Monad Metropolis 评审期，求轻喷、求反馈）

### C2. V2EX（技术向，self-hosted 受众）
**自托管：给 AI Agent 一把"花钱的 API Key"（x402 / USDC / 自部署）**

场景：AI 要调付费 API（数据、模型、工具），x402 协议让它可以按次付 USDC，但没人想把私钥交给 agent。托管钱包（Coinbase/MetaMask agent wallet 等）又把人锁在某个平台上。

MoneySwitch 的做法：一台自己部署的小服务器，管一个小额钱包；给每个 agent 发一把可撤销的 MoneyKey（日额度/总额度/单笔上限/域名白名单/审批线/过期时间）；超过审批线要人用 4–6 位 PIN 批准，AI 永远不能自己批准自己；每笔都明确返回 `charged: yes/no/maybe`，结果未知绝不自动重试。

一条规则：**一台 MoneySwitch 只替一个出钱的人花钱**——不注册、不收陌生人的钱，那叫托管不叫基础设施。

主网证据：agent 的 key 在 Monad 主网通过 x402 买了 Nansen 数据（0.01 USDC，tx 链上可查）；Qwen agent 按 $0.09 预算自己买了 5 次 Nansen 查询。测试网 2 分钟上手：粘贴一段话给 Claude Code/Codex 即可。

开源 AGPL：github.com/dongsheng123132/moneyswitch · 在线测试：app.moneyswitch.dev
想听听：让 AI 花真钱之前，你最需要什么？你会先让它买什么？

### C3. 掘金（开发者文章体，开头 + 提纲）
**给 AI 一把"花钱的 API Key"：自托管 x402 付款服务器的设计与信任模型**

> 开场：AI 在替我们调用付费 API，但「谁付钱、怎么付、AI 会不会乱花」还没人真正解决。x402 让按次付费成为可能，但私钥不能给 AI。这篇文章讲我们怎么把一个自托管付款服务器做小、做诚实。
> 提纲：问题（私钥 vs 托管）→ 设计（钱包/Key/支付三件事，26 条路由）→ 信任模型（PIN 审批、charged yes/no/maybe、不自动重试、三次安全评审）→ 主网证据（Nansen、Qwen agent）→ 10 分钟上手路径 → 边界与反思。

---

## D. Product Hunt 发布包（建议 11/4–11/6，周二–周四）

### D1. 基本信息
- 产品名：**MoneySwitch**
- Tagline（推荐）：**Give your AI agent an API key for money**
- 备选：Self-hosted USDC payments for AI agents — budgets, approvals, receipts, no private keys
- 分类：Developer Tools > API / AI；关键词 x402、AI agents、USDC、self-hosted
- 官网落地页：https://moneyswitch.dev（**发布前确认英文版已上线**）
- Hunter：优先找一位社区 hunter（Monad Discord / x402 社区）；无则发布当天自荐

### D2. 产品描述（Description）
x402 lets AI agents pay for APIs per request in USDC — but nobody wants to hand an agent a private key, and hosted agent wallets lock you to one platform.

**MoneySwitch is the open-source, self-hosted policy and ledger layer for your agents.** One small float wallet on your own server; every agent gets its own revocable MoneyKey with daily/total budgets, per-request limits, allowed hosts and an approval threshold. Payments above the line need a human's 4–6 digit PIN — an agent can never approve itself. Every payment has an on-chain receipt, and every answer says whether money moved (`charged: yes / no / maybe`).

Connecting an agent is pasting one block of text into Claude Code, Codex or OpenClaw. Live on Monad testnet today; mainnet proof: an agent's key bought Nansen's Token Screener over x402 for 0.01 USDC, verified on-chain.

**Try it in ~2 minutes:** https://app.moneyswitch.dev · **Code:** https://github.com/dongsheng123132/moneyswitch

### D3. 首条评论（发布 00:01 PT 后立即发出）
Hey Product Hunt 👋 We're the team behind MoneySwitch, built for Monad Metropolis (Track 04: Trust, Identity & AI Infrastructure).

The itch: x402 finally lets an AI agent pay for an API call in USDC — but handing an agent a private key is insane, and hosted wallets only work for one person on one platform. So we built the missing layer: a self-hosted server where an organization gives each of its agents a budget-limited "MoneyKey". Big payments need a human's approval (4–6 digit PIN, never the AI), every payment has an on-chain receipt, and unknown outcomes are never retried automatically.

On Monad mainnet an agent's key bought Nansen data over x402 for 0.01 USDC — verified on-chain. On testnet you can reproduce the whole flow in ~2 minutes.

Happy to answer anything — especially: what would *you* need before letting an agent spend real money?

### D4. 配图清单（按 PH 画廊顺序）
| 顺序 | 文件（相对 C:\1mineyswitch） | 说明 |
|---|---|---|
| 封面 | `docs/pitch/deck-v2/shots/01.png` | 主视觉/钩子页 |
| 2 | `docs/pitch/deck-v2/shots/05.png` | 核心流程 |
| 3 | `docs/pitch/deck-v2/shots/10.png` | 信任/安全页 |
| 4 | `output/approval-task-context/dashboard-desktop.png` | 最新 Dashboard（桌面） |
| 5 | `output/approval-task-context/live-pin-desktop.png` | PIN 审批流实拍 |
| 6 | `output/approval-task-context/dashboard-mobile.png` | 移动端 |
| 视频 | `docs/pitch/video/moneyswitch-pitch-v3-share.mp4` | 演示视频（如 PH 支持则放视频位） |

### D5. 发布日打法（2026 实测经验）
- 时间：PT 0:01 后上线（北京时间下午 3 点后）；**周二–周四**最稳
- 首评立刻发（见 D3）；之后 1–2 小时内每条评论都回复
- 拉票用「波浪式」：分几个时段通知朋友，避免同一分钟集中轰炸；每时段 <100 票、注意地域分散
- 同步发一条 X 带 PH 链接，Discord 发一次（不刷屏）
- 发布后 30 天：把 PH 页转成落地页引流，持续回复新评论

---

## E. 生态目录提交清单（10/15–10/24）

### E1. agentpaymentsstack.com（官方 Submit a project 表单）
- 项目名：MoneySwitch
- 层级：**L4 Governance & Policy**（如有单选可兼 L1 Wallet & Key Mgmt）
- 状态：Live（主网有真实交易）
- 官网：https://moneyswitch.dev
- GitHub：https://github.com/dongsheng123132/moneyswitch
- 一句话：Self-hosted policy & ledger layer for agent payments — budget-limited MoneyKeys, human PIN approval, on-chain receipts, x402-native on Monad & Base.
- 采纳信号：Monad 主网真实付款（Nansen x402，tx `0x98297ba4…e5e9c`）；测试网公开实例；v0.7.6 连续发布

### E2. awesome-x402（xpaysh/awesome-x402，GitHub PR）✅ 已提交 10/15 · PR #1837
- PR 标题：`Add MoneySwitch: self-hosted buyer-side payment server for agents`
- PR 正文：
  > Adds [MoneySwitch](https://github.com/dongsheng123132/moneyswitch) — a self-hosted server that lets AI agents pay x402 APIs in USDC without holding a private key. Each agent gets a budget-limited, revocable MoneyKey; payments above a threshold need human approval; every payment has an on-chain receipt. Open source (AGPL), live on Monad mainnet & testnet, Base.
  > Fits the buyer-side tools section: it's the "AI doesn't hold a key" counterpart to the seller-side toll booths.
- 位置：按 README 现有分类（买方工具 / 自托管服务器一栏）放置，先 fork → 加条目 → PR

### E3. agent402.tools / x402Radar / x402Agentic（官网联系方式）
Subject: A self-hosted way for AI agents to pay x402 APIs without holding a key

Hi <name/team>,
I'm building MoneySwitch, an open-source, self-hosted server that lets AI agents (Claude Code, Codex, OpenClaw) pay x402 APIs in USDC on Monad and Base. The agent gets a budget-limited key instead of a private key; payments above a threshold need a human's approval; every payment has an on-chain receipt. We already buy x402 services with it — e.g. Nansen on Monad mainnet (tx `0x98297ba4…e5e9c`). I'd love to be listed as a buyer-side tool, or to hear what your buyers struggle with when paying.
Code: https://github.com/dongsheng123132/moneyswitch · Live (testnet): https://app.moneyswitch.dev
Thanks!

---

## F. Show HN + dev.to 技术长文（10/22–10/27）

- **Show HN 标题**：Show HN: MoneySwitch — give your AI agent an API key for money (self-hosted, x402, Monad)
- **dev.to 标题**：How we let AI agents pay for APIs without ever holding a private key
- 结构：
  1. 问题：私钥不能给 AI；托管钱包锁平台；团队要自己的账本和治理
  2. 设计：三件事（钱包 / Key / 支付），四页管理台 + 26 条路由，刻意做小
  3. 信任模型：策略先于签名（单事务）、PIN 审批、`charged: yes/no/maybe`、未知不重试、三次独立安全评审
  4. 主网证据：Nansen x402 付款 tx、Qwen agent 按 $0.09 预算自买 5 次查询
  5. 10 分钟上手路径（验收测试）：测试网完整复现
  6. 边界与反思：一台只替一个出钱的人；不做多租户托管；任务备注只作审计线索
- 配图：`docs/pitch/deck-v2/shots/01.png`、`05.png`、`10.png` + `output/approval-task-context/live-pin-desktop.png` + 帧图若干
- 发 HN 时间：美东早 9–10 点（评审期尾声，评委和社区都看得到）

---

## G. 素材索引（渠道 → 文件）

| 素材 | 路径（相对 C:\1mineyswitch） | 用途 |
|---|---|---|
| Deck 截图 ×16 | `docs/pitch/deck-v2/shots/01.png … 16.png` | X 线程、PH 画廊、长文配图 |
| Deck PDF | `docs/pitch/deck-v2/shots/deck-print-v2.pdf` | 附件投递、评委 |
| 视频 v3 分享版 | `docs/pitch/video/moneyswitch-pitch-v3-share.mp4` | X、PH、Discord |
| 视频帧图 ×34 | `docs/pitch/video/frames-v3/frame-00…33.png` | X 线程、文章 |
| Dashboard 桌面/移动 | `output/approval-task-context/dashboard-desktop.png` / `dashboard-mobile.png` | PH、最新截图 |
| PIN 审批流实拍 | `output/approval-task-context/live-pin-desktop.png` | 信任叙事 |
| 海报 300dpi | `output/poster/2026-10-13-xiapan/xiapan-landscape-print-300dpi.png` | 社媒头图/线下 |
| 英文/中文文案 | `docs/pitch/judge-post-2026-10.md`、`docs/pitch/outreach-2026-10.md` | 各渠道改写底稿 |

---

## 发布顺序建议（一次只推一件事）

1. **10/15–18**：Discord 帖（B）+ 中文即刻（C1）→ 请评委/社区试用，回收反馈
2. **10/16**：X 线程（A）挂视频 → 主网证据扩散
3. **10/15–24**：目录提交（E）→ 长期 SEO + 生态位
4. **10/22–27**：Show HN + dev.to（F）→ 评审期尾声的技术背书
5. **11/4–6**：Product Hunt（D）→ 带「获奖/入围」叙事收割
