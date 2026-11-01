# 给评委的动态 / 测试说明（发布前由用户过目；`<ADMIN_TOKEN>` 由你自己填）

---

**MoneySwitch v0.7 — give your AI an API key for money. Try it yourself on Monad testnet.**

MoneySwitch is a small self-hosted server that lets AI agents pay x402 APIs in USDC without ever holding a private key. Each agent gets its own budget-limited key; payments above a threshold need a human's approval; every payment has an on-chain receipt.

**One rule decides the product: one MoneySwitch spends money for exactly one payer.** No sign-ups, no deposits from strangers. That would be custody, not infrastructure.

**This week (v0.7):**
- Cut to the core: the local desktop console, CLI and MCP adapters, the model gateway, the seller-side toll booth, push channels and the employee portal are gone. Left: four admin pages (Wallet, Keys, Approvals, Bills), 26 HTTP routes.
- Connecting an agent = pasting one block of text (a skill with the server URL and that agent's own key).
- A wallet you can't lock yourself out of: one-click creation, a 12-word recovery phrase, auto-unlock after restarts, safe replacement. Three independent security reviews.
- Honest money: every answer says `charged: yes / no / maybe`; an unknown outcome is never retried automatically.

**Try it — this is a public TEST server (Monad testnet, test USDC with no value):**
1. Open https://app.moneyswitch.dev and sign in with this administrator token: `<ADMIN_TOKEN>`
2. Go to **Keys** → create a key for your AI (for example total 0.1, per request 0.01) and keep **"allow the test payment endpoint"** ticked.
3. Copy the text the page gives you and paste it into Claude Code or Codex. Your agent saves the skill, checks its budget, pays 0.01 test USDC to our test endpoint and shows you the transaction.
4. Want to see the approval flow? Create another key with an approval threshold of 0.005. Your agent will hand you an approval link; approve it on the **Approvals** page and the agent pays.
5. Look at **Bills**: every payment, with its on-chain transaction.

Please be kind to the shared test wallet. The token will be rotated after judging.

**We'd love your answer to three questions:**
1. Is "one instance = one payer" the right boundary for agent-payment infrastructure?
2. What would you need before letting an agent spend real money?
3. Which x402 services (on Monad or Base) would you want your agents to buy first?

Code: https://github.com/dongsheng123132/moneyswitch (v0.7.0) · Website: https://moneyswitch.dev

---

**中文版（发国内社区用）**

**MoneySwitch v0.7：给 AI 一把"花钱的 API Key"。欢迎在 Monad 测试网上亲手试。**

MoneySwitch 是一个自己部署的小服务：AI 用 USDC 付 x402 接口，但永远拿不到私钥。每个 AI 一把有额度的 key，超过审批线要人批，每笔都有链上凭证。
**一条规则决定整个产品：一台 MoneySwitch 只替一个出钱的人花钱。** 不做注册、不收陌生人的钱——那叫托管，不叫基础设施。

这周（v0.7）：砍掉了本机桌面、命令行和 MCP、模型网关、收费站、推送、员工门户，只剩钱包、Key、审批、账单四页；接 AI 只要粘贴一段话；钱包不会把自己锁死；每笔都说清扣没扣钱。

**试用（公开测试服务器，测试网，测试币没有价值）：**
1. 打开 https://app.moneyswitch.dev ，用管理员令牌登录：`<ADMIN_TOKEN>`
2. 在 **Key** 页给你的 AI 发一把 key（比如总额 0.1、单笔 0.01），保持勾选"允许付款测试接口"。
3. 复制页面给出的那段话，粘贴给 Claude Code 或 Codex。AI 会保存技能、查额度、付 0.01 测试币，并给你交易号。
4. 想看审批：再发一把审批线 0.005 的 key。AI 会给你一个审批链接，在 **审批** 页批准后它才付款。
5. 在 **账单** 页能看到每一笔和它的链上交易。

测试钱包是大家共用的，请手下留情。评审结束后令牌会更换。

想听听你的三点意见：一台只替一个出钱的人花钱，这条边界对吗？让 AI 花真钱之前你需要什么？你最想让 AI 先买哪些 x402 服务？
