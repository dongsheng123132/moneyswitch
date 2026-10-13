# MoneySwitch 官网定位与文案修改建议 — 2026-10-13

范围：当前首页、付款证据和试用入口的内容审查。基于当前站点源码、只读访问和链上交易验证；本次不构成逐屏视觉/无障碍审查。下列文案为建议稿，尚未修改或发布官网。

## 建议定位

给 AI 一把有预算、可审批、可撤销的付款 Key。

MoneySwitch 是由用户自行部署的 Agent 付款服务：每个 Agent 持独立 MoneyKey，通过统一入口调用兼容的 x402 付费接口；用户设置额度和允许域名，在需要时输入确认码审批，并按 Agent、服务和链查看账单。钱包签名由用户自己的服务器执行。

## 当前页面的具体问题

1. 首屏 `site/index.html` / `hero.title` 和 `site/assets/js/i18n.js` 重点写“Programmable Web3 cloud wallet”。这说明了技术形态，但用户最先需要理解的是“给 Agent 什么、能买什么、如何控制支出”。建议把 MoneyKey 的动作放在标题里，把自托管放在副标题。
2. 架构图只列 Monad · Base；`how.5` 的中英文也只列两条链。加入 Solana，说明链必须同时为 Key 和商户支持，显式指定链时不回退。
3. 首个付款案例、演示和 proof 主表突出旧 Monad 测试网交易；主网证据放在长段落里，`stat.main` 静态写 9 笔。建议先展示带时间、金额、服务、网络和交易链接的近期主网案例，旧测试网记录保留在单独区域；统计从统一证据数据生成，避免硬编码重复维护。
4. 主按钮“参与首批试用”落到试用说明页面，而不是一条明确的首次付款路径。建议主按钮“完成第一笔测试付款”，指向清楚列出部署、创建 Key、接入 Agent、查看回执的指南；次按钮“查看主网付款证据”。不要暗示 app.moneyswitch.dev 是开放注册的托管钱包。
5. 新用户应在接入指南看到一个具体审批例子：单笔上限 0.02 USDC、审批阈值 0.01 USDC；达到阈值暂停；人打开官方链接输入确认码；Agent 按原请求继续。新审批 30 分钟有效，批准不刷新期限。确认码交给人，MoneyKey 交给 Agent。
6. 展示“可调用服务”，按“已付费验证 / 仅检查报价”区分。已验证：CoinGecko（Base、Solana）、Quicknode（Base）、AgentVerse（Monad）；AgentVerse Solana 收款已部署且报价可用，尚未完成该商户的真实 Solana 购买；BlockRun 本次仅检查报价。不要列成全量兼容或官方合作关系。

## 可替换的首页首屏文案

中文主标题：给 AI 一把有预算的付款 Key。

中文副标题：每个 Agent 一把 MoneyKey，分别设置单笔、每日和总预算。调用兼容的 x402 付费接口时，MoneySwitch 检查额度和域名；达到审批阈值，由你输入确认码批准。支持 Solana、Base、Monad 的 USDC，签名服务部署在你自己的服务器上。

短句：额度由你设，审批由你做，账单随时可查。

英文主标题：Give your AI a spending key.

英文副标题：Issue a separate MoneyKey to each agent. Set per-request, daily and total budgets, allowed service domains and a human approval threshold. Pay compatible x402 APIs in USDC on Solana, Base and Monad, with wallet signing on your own server.

英文短句：Set the budget. Approve the exceptions. Review every payment.

按钮：Make your first test payment / View mainnet payment proof。

## 同行比较与定位依据

| 产品 | 已有能力与主要入口 | 对 MoneySwitch 的启示 |
|---|---|---|
| [Coinbase Agentic Wallets](https://www.coinbase.com/en-au/developer-platform/products/agentic-wallets) | 面向 Agent 的钱包基础设施，已有消费限额、私钥隔离和 x402；[钱包界面](https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/show-wallet-app)支持按调用/会话设置额度及交易历史 | 消费限额和不向 LLM 暴露钱包私钥已经是同行能力。突出自托管、每 Agent 独立 MoneyKey、域名/金额审批、统一账单的整体体验，不声称这些基础功能独家或比同行更安全 |
| [Quicknode](https://github.com/quiknode-labs/quicknode-x402) | SDK 提供 x402 RPC 付款，按次、信用额度、Gateway 多种模式；真实服务价值明确 | 首页应说明用户买到的实际服务，并给出已跑通的金额、接口和回执 |
| [BlockRun](https://github.com/BlockRunAI/blockrun-llm) | 提供模型推理等服务，通过 Base/Solana USDC 钱包按调用付费 | 展示跨服务的统一付款入口；保留兼容范围，别把未完成付款验证的服务列为已验证 |
| [Coinbase CDP Facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator)、[PayAI SDK](https://github.com/PayAINetwork/x402-solana) | 验证/结算或支付 SDK 基础设施，与付款服务、商户 API 的角色不同 | MoneySwitch 可接在现有 x402 生态上；AgentVerse 是演示商户，MoneySwitch 是付款服务，正文中清楚分工 |

这些是基于公开文档的定位建议，不是对同行全部功能的排除式比较。

## 参赛项目简介替换稿

MoneySwitch is an open-source, self-hosted spending gateway for AI agents. Each agent receives a revocable MoneyKey with per-request, daily and total budgets, allowed service domains and human approval rules. Wallet signing stays on the owner's server. MoneySwitch pays compatible x402 APIs in USDC on Solana, Base and Monad, with real mainnet payments verified. One dashboard keeps approvals and bills organized across agents and separates confirmed spending from payments awaiting reconciliation.

## 实施范围

优先更新 `site/index.html`、`site/assets/js/i18n.js` 的首屏、链支持说明与证据区，再同步 `site/pilot/index.html` 和 `site/pilot/zh/index.html`。交易证据应来自一份结构化数据，现有 `site-data/build-site-data.mjs` 目前只处理测试网记录，可扩展为分别生成主网和测试网列表。旧演示视频、图片和博客标明历史日期，不把历史测试网视频当成新主网演示。新确认码表单可录一段简短付款过程，在实际录制后再换视频封面和说明。
