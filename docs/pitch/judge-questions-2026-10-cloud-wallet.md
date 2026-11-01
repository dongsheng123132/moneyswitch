# 给评委的动态 / 测试说明（云钱包版 v0.8 draft，发布前由用户过目；`<ADMIN_TOKEN>` 由你自己填）

> 本稿是 judge-post-2026-10.md（v0.7 版）的升级稿：叙事从「x402 付款服务器」升级为「可云自托管的可编程多 agent 支出钱包」。定位梳理见同目录 `cloud-wallet-positioning-2026-10.md`。

---

**MoneySwitch v0.8 — a self-hosted cloud wallet that gives every AI an API key for money, with a reason attached to every spend. Try it on Monad testnet.**

MoneySwitch is a small self-hosted server that acts as the **cloud wallet for all your AI agents** — Claude Code, Codex, Qwen, bots across your office, cloud and servers. One wallet, one pool of USDC, controlled by you: every agent gets its own budget-limited MoneyKey (`mk_live_…`), payments above a threshold need your approval, and **every payment carries a task note — which agent spent how much, on what, for which task** — auditable in one Bills page with its on-chain receipt. The private key never leaves your server and never reaches the AI.

**What changed since v0.7:**
- Positioned as a **cloud wallet / spending-governance layer**, not just an x402 client: one deployment = one organization, N agents.
- **Task-level audit trail (new):** agents report `task_id` + `purpose` with each payment; Bills can be filtered and exported per task. Spending becomes explainable.
- **Self-service sub-keys (new, UI):** any key allowed to delegate can be split into child keys within the parent's limits; the whole chain is checked before every signature, and revoking a parent stops every descendant instantly.
- Everything else stays: wallet with 12-word recovery, keys with daily/total/per-request limits and host allowlists, human approval via a confirmation code (never given to the AI), honest billing (`charged: yes/no/maybe`), EIP-3009 USDC payments that are **gasless for the payer** (a facilitator submits the transfer), testnet/mainnet separation.

**Try it — this is a public TEST server (Monad testnet, test USDC with no value):**
1. Open https://app.moneyswitch.dev and sign in with this administrator token: `<ADMIN_TOKEN>`
2. Go to **Keys** → create a key for your AI (e.g. total 0.1, per request 0.01) and keep **"allow the test payment endpoint"** ticked.
3. Copy the text the page gives you and paste it into Claude Code or Codex. Your agent saves the skill, checks its budget, **reports a task note**, pays 0.01 test USDC to our test endpoint and shows you the transaction.
4. Want to see the approval flow? Create another key with an approval threshold of 0.005. Your agent will hand you an approval link; approve it on the **Approvals** page and the agent pays.
5. Look at **Bills**: every payment with its task note and its on-chain transaction.

Please be kind to the shared test wallet. The token will be rotated after judging.

**We'd love your answers to five questions:**
1. **Boundary:** one deployment = one organization's agents (we never hold strangers' money — that's custody, not infrastructure). Is "one wallet per organization, many agent keys" the right boundary for agent-payment infrastructure? Does multi-tenant (running wallets for many orgs) inevitably slide into custody/licensing?
2. **Audit:** agents self-report `task_id` + `purpose` for every spend. Is self-reported purpose a trustworthy audit trail, or is that inherently gameable by prompt injection? What does a judge actually want recorded before letting an agent spend?
3. **Trust:** what would you need before letting an agent spend real money? (server-side policy, on-chain policy, or something else?)
4. **Key security:** our wallet is a locally-held key (12-word recovery, encrypted at rest, decrypted only in process memory). We're planning hot-wallet layering + Safe smart-account policy on-chain. For a self-hosted wallet, what level of key security counts as "good enough"?
5. **Ecosystem:** which x402 services (on Monad or Base) would you want your agents to buy first?

Code: https://github.com/dongsheng123132/moneyswitch (v0.8) · Website: https://moneyswitch.dev

---

**中文版（发国内社区用）**

**MoneySwitch v0.8：给所有 AI 一把「花钱的 API Key」的云钱包，每笔钱都带着理由。欢迎在 Monad 测试网上亲手试。**

MoneySwitch 是一个自托管的小服务，是你**所有 AI agent 的云钱包**——Claude Code、Codex、Qwen、公司各台电脑和云端服务器上的 bot，共用同一个 USDC 池，由你统一控制：每个 agent 一把有额度的 MoneyKey（`mk_live_…`），超过审批线要你批，**每笔付款都带任务备注**（哪个 agent、花了多少、买什么、为哪个任务），在账单页一键可查、可导出、带链上凭证。私钥永远留在你的服务器上，AI 永远拿不到。

**相比 v0.7 的变化：**
- 定位升级为**云钱包 / 支出治理层**，不再只是 x402 客户端：一个部署 = 一个组织，N 个 agent。
- **任务级审计（新增）**：agent 每笔付款上报 `task_id` + 用途；账单可按任务筛选和导出——AI 花钱从此可解释。
- **子 key 自助申请（新增界面）**：允许授权的 key 可在父额度内拆子 key，每次签名前沿整条链检查额度，撤销父 key 级联停掉所有后代。
- 其余不变：12 词钱包、额度/域名白名单/审批线、确认码人工审批（不给 AI）、诚实的扣款状态（charged yes/no/maybe）、EIP-3009 USDC 付款**付款方免 gas**（由 facilitator 提交结算）、测试网/主网分离。

**试用（公开测试服务器，测试网，测试币没有价值）：**
1. 打开 https://app.moneyswitch.dev ，用管理员令牌登录：`<ADMIN_TOKEN>`
2. 在 **Key** 页给你的 AI 发一把 key（比如总额 0.1、单笔 0.01），保持勾选「允许付款测试接口」。
3. 复制页面给出的那段话，粘贴给 Claude Code 或 Codex。AI 会保存技能、查额度、**上报任务备注**、付 0.01 测试币，并给你交易号。
4. 想看审批：再发一把审批线 0.005 的 key。AI 会给你一个审批链接，在 **审批** 页批准后它才付款。
5. 在 **账单** 页能看到每一笔、它的任务备注和链上交易。

测试钱包是大家共用的，请手下留情。评审结束后令牌会更换。

**想听你对五个问题的意见：**
1. 边界：一个部署 = 一个组织的 agent（我们不替陌生人管钱——那是托管，不是基础设施）。「一个组织一个云钱包、N 把 agent key」这条边界对吗？做多租户（替多个组织管钱）是不是必然滑向托管和牌照问题？
2. 审计：agent 每笔自报 `task_id` 和用途，自报的用途作为审计线索可信吗？会不会被 prompt injection 伪造？让 agent 花钱之前，评委真正想记录的是什么？
3. 信任：让 AI 花真钱之前，你最需要什么（服务端策略、链上策略、还是别的）？
4. 密钥安全：我们目前是本地密钥（12 词恢复、加密存储、仅在进程内存中解密）。后续计划做热钱包分层 + Safe 智能账户链上策略。对自托管钱包，什么级别的密钥安全算「够用」？
5. 生态：在 Monad 或 Base 上，你最想让 agent 先买哪些 x402 服务？
