# 对外沟通草稿（2026-10，发送前由用户过目、由用户发送）

> 三份草稿：①请评委来看 + 进展汇报；②用户调研问题；③x402 冷启动联系。
> 原则：只走公开渠道（项目的 Discord、GitHub Issues/Discussions、官网联系方式），不去翻作者的私人邮箱。

---

## ① 请评委来看 + 进展汇报（英文发评委 / Discord，中文自用）

**Subject: MoneySwitch v0.7 — give your AI an API key for money (try it in 2 minutes on Monad testnet)**

Hi,

We're building **MoneySwitch** for Monad Metropolis (Track 04). It is a small, self-hosted server that lets AI agents pay x402 APIs in USDC without ever holding a private key: each agent gets its own budget-limited MoneyKey, payments above a threshold need a human's approval, and every payment has an on-chain receipt.

**One rule decides the product: one MoneySwitch spends money for exactly one payer** — you, or your company. No sign-ups, no deposits from strangers, no keys for other people's money. That would be custody, not infrastructure.

What changed in the last week (v0.7):
- **Cut to the core.** We removed everything that did not serve "an agent pays an x402 API within your budget": the local desktop console, the CLI and MCP adapters, the model gateway, the seller-side toll booth, push channels and the employee portal. What is left: four admin pages (Wallet, Keys, Approvals, Bills) and 26 HTTP routes.
- **Connecting an agent = pasting one block of text** (a skill with the server URL and that agent's own key) into Claude Code, Codex or OpenClaw.
- **A wallet you cannot lock yourself out of**: one-click creation, a 12-word recovery phrase shown once, auto-unlock after restarts, and safe replacement. Three independent security reviews.
- **Honest money**: every answer says whether money moved (`charged: yes / no / maybe`); an unknown outcome is never retried automatically.

**Try it (Monad testnet, ~2 minutes):** paste the skill text from our submission into Claude Code or Codex. Your agent pays 0.01 test USDC to our test endpoint and shows you the transaction. With the second key, every payment needs approval: your agent hands you a link, you approve in the dashboard, and only then does it pay.

**We'd value your opinion on three things:**
1. Is "one instance = one payer" the right boundary for agent payments infrastructure?
2. What would you need before letting an agent spend real money: per-day budgets, approvals, allow-lists, something else?
3. Monad and Base are supported today. Which x402 services would you want your agents to buy first?

Live product (testnet): https://app.moneyswitch.dev · Code: https://github.com/dongsheng123132/moneyswitch (v0.7.0)

Thank you!

**中文要点（自用）：** 一条规则——一台 MoneySwitch 只替一个出钱的人花钱；这周砍掉了本机桌面、命令行和 MCP、模型网关、收费站、推送、员工门户；接 AI = 粘贴一段话；钱包不会把自己锁死；每笔都说清扣没扣钱。请评委 2 分钟亲手试，并回答三个问题。
（AgentVerse 是独立项目：它这周改成"人只看、AI 来买"，格子购买由 AI 通过 x402 完成；如需在汇报里提，可加一句，不要和 MoneySwitch 混在一起讲。）

---

## ② 用户调研问题（问评委、x402 开发者、早期用户）

只问事实和最近一次的经历，不问"你会不会喜欢"。

1. 你现在让 AI 调用付费 API（数据、模型、工具）时，钱是怎么付的？最近一次是哪一个服务？
2. 你愿意让 AI 每天自己花多少钱而不用问你？超过多少必须先问你？
3. 你会把这类服务部署在自己的服务器上，还是更愿意用托管平台（Coinbase、MetaMask Agent Wallet 等）？为什么？
4. 你用过哪个 x402 服务？是在 Base 还是 Monad 上？付款体验最卡的一步是什么？
5. 给 AI 接上付款能力，你最担心的是什么：私钥泄露、AI 乱花钱、重复扣款，还是记账对不上？
6. 如果明天就能用，你会先让哪个 AI（Claude Code、Codex、OpenClaw、自己写的 agent）用？买什么？
7. （对 x402 卖家）你的服务现在一天有多少笔 x402 付款？买家里有多少是 AI？
8. 哪个功能少了你就不会用？哪个功能有了也不会用？

---

## ③ x402 冷启动联系（走公开渠道）

**对象（都是公开项目，只用公开渠道联系）：**
| 对象 | 为什么找他 | 渠道 |
|---|---|---|
| x402 官方仓库（x402-foundation/x402） | 买方侧的基础设施，正好补"AI 不拿私钥怎么付"的空白 | GitHub Discussions |
| xpaysh/awesome-x402 | x402 资源清单，MoneySwitch 属于"买方工具"一栏 | 提一个 PR 把 MoneySwitch 加进去（**【待你】同意后再提**） |
| agent402.tools | Monad 上最大的 x402 服务索引（约占七成） | 官网上的联系方式 |
| Molandak facilitator（Monad 官方结算服务） | 我们所有 Monad 付款都经过它 | Monad Discord |
| Nansen（x402 API） | 我们在主网上真实买过它的数据，可以做案例 | 黑客松赞助商渠道 / Discord |
| x402Radar 等目录站 | 收录买方工具 | 官网联系方式 |

**邮件 / 帖子模板（英文）：**

Subject: A self-hosted way for AI agents to pay x402 APIs without holding a key

Hi <name / team>,

I'm building MoneySwitch, an open-source, self-hosted server that lets AI agents (Claude Code, Codex, OpenClaw) pay x402 APIs in USDC on Monad and Base. The agent gets a budget-limited key instead of a private key; payments above a threshold need a human's approval; every payment has an on-chain receipt.

We already buy x402 services with it — for example <service> on Monad mainnet (tx <hash>). I'd love to:
- <for marketplaces>: list MoneySwitch as a buyer-side tool, or hear what your buyers struggle with when paying;
- <for sellers>: hear whether AI buyers with budgets and approvals would help your service.

Code: https://github.com/dongsheng123132/moneyswitch · Live (testnet): https://app.moneyswitch.dev

Thanks,
<你的名字>
