# MoneySwitch 第二轮发稿包：给 AI Bot 的可编程 Web3 云钱包

准备日期：2026-10-08。

## 作者说明：发布前看，不复制到用户文案

本轮新增观点文章、贡献入口与配图，第一轮文章和素材继续保留。重点从“来试一试”扩展为“试用后，一起把给 AI Bot 用的钱包做好”：修部署说明、提供最小复现、改善 Agent 接入体验，欢迎范围清楚的 PR。

本文件是本地素材包，不表示已在任何外部平台发布。文中的新页面、文章和图片需与网站上线同步：先确认对应线上地址可访问、图片正常、贡献与试用链接完整，再复制含链接的稿件。这个上线提醒只留在作者说明，不放进公开文案。

首发长文建议放官网，中文社区使用中文文章，英文博客使用英文文章；支持 canonical 的转载位置，可填写对应官网文章地址。短帖选一个具体问题开头，链接导向贡献指南；读者想先试用时，再补试用入口。不要把同一段介绍重复塞进无关讨论。

奖励口径仅为“视试用与反馈情况酌情给予奖励”。没有固定金额、参与即得、提交 PR 即得或合并必奖的承诺。下方短文案以产品与贡献为主，确有需要时再补末尾的奖励说明。

HN 延续本目录 `hn-author-notes.md` 的作者自写要求。下面的 Show HN 标题与首评仅作为私下事实、结构候选，不直接粘贴投稿；发布前由作者本人根据实际经历自行写作。Show HN 链接应指向可找到源码与运行说明的产品入口，不把纯招募页当成可运行产品。不要组织投票或代发，讨论由作者本人参与。

### 长文与入口

| 用途 | 中文 | English |
|---|---|---|
| 本轮主文 | https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/zh/ | https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/ |
| 贡献指南，主要 CTA | https://moneyswitch.dev/contribute/zh/ | https://moneyswitch.dev/contribute/ |
| 先试用，辅助 CTA | https://moneyswitch.dev/pilot/zh/ | https://moneyswitch.dev/pilot/ |

中文长文源：`docs/blog/cloud-wallet-for-ai-bots.zh.md`。

英文长文源：`docs/blog/cloud-wallet-for-ai-bots.md`。

### 配图

本轮原图目录：`site/assets/img/cloud-wallet-2026-10/`。网页使用的 WebP 与可用于发帖的 PNG 分开保存；发帖时选下面的 PNG。

| 图片 | 建议用途 |
|---|---|
| `cover-zh.png` | 知乎文章封面、中文博客头图、朋友圈横图 |
| `cover-en.png` | 英文博客封面、X 配图 |
| `contribute-zh.png` | 小红书或朋友圈竖版贡献邀请海报 |

配图只能表达产品结构和贡献邀请，不作为实际用户数量、使用结果或安全保证的证据。若补后台截图，使用测试数据并遮掉 Key、PIN、管理员链接、恢复词和敏感请求参数。

## 知乎导语

AI 已经能写代码、部署服务、调用工具了。但当一个 API 要收费时，我们该给它多大的花钱权限？

我在做的 MoneySwitch，想回答这个具体问题：给 AI Bot 一个可编程的 Web3 云钱包。钱包服务由你自己部署，同一个出资方提供资金，不同 Agent 各拿一把独立的 MoneyKey。日额度、总额度、单笔上限和审批线由服务执行，达到审批线先问人，用完可以单独撤销。

这里的 Web3 具体指 USDC / x402 付款，当前支持 Monad 和 Base；它不是任意链的钱包，也不能代付所有模型订阅。“云钱包”也不是向我们注册账户充值，而是你在自己的服务器上运行的钱包服务。

这一篇讲讲为什么这么做，以及当前实现的边界。项目开源，欢迎你试用后修一处部署说明、补一个最小复现，或改善自己使用的 Agent 的接入体验。一起打造给 AI Bot 用的 Web3 云钱包，欢迎提交 PR。

贡献指南：https://moneyswitch.dev/contribute/zh/

想先跑一遍：https://moneyswitch.dev/pilot/zh/

## 小红书短文案

标题：AI Bot 会写代码了，花钱权限怎么给？

电脑上的 Codex、另一台机器上的 Claude Code、云端自己的 Agent……当它们需要付费调用 API，预算是不是也能在一个地方管？

我在做 MoneySwitch：给 AI Bot 用的可编程 Web3 云钱包。

你自己部署钱包服务，每个 Agent 一把独立 Key：能花多少、能访问哪些域名、达到多少金额需要人批准，都有明确规则。付款能查账，不需要的 Key 可以撤销。

目前还是早期自托管版本，支付支持 Monad / Base 上兼容的 USDC / x402 服务，不是所有 AI 订阅都能付。试用先用没有真实价值的测试币。

想邀请正在用 Agent 的开发者一起做：修文档、复现问题、改善接入体验，小 PR 也欢迎。

一起打造给 AI Bot 用的 Web3 云钱包，提交 PR：
https://moneyswitch.dev/contribute/zh/

想先试用：
https://moneyswitch.dev/pilot/zh/

## 朋友圈短版

AI 会写代码了，花钱权限怎么给？

我在做 MoneySwitch：给 AI Bot 用的可编程 Web3 云钱包。自己部署一个服务，每个 Agent 单独发额度 Key，需要时交给人审批，付款能查账，Key 能撤销。

当前支持 Monad / Base 上兼容的 USDC / x402 服务，先用测试币体验。项目开源，欢迎试用后修文档、提问题、改接入体验，一起提交 PR 把它做好。

贡献指南：https://moneyswitch.dev/contribute/zh/

产品思路：https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/zh/

## X 英文单帖

```text
Building MoneySwitch: a programmable Web3 cloud wallet for AI bots. Self-hosted, separate spending keys, budgets and approvals. USDC/x402 on Monad + Base.

Try it, fix a rough edge, send a PR:
https://moneyswitch.dev/contribute/
```

### X 可选跟帖

```text
The first trial uses two agent keys and test USDC with no monetary value. We're looking for concrete feedback on deployment, connecting agents, approvals and bills.

Start here: https://moneyswitch.dev/pilot/
```

## 英文博客分享导语

An AI bot can write code and decide which API to call. What should it be allowed to spend?

We're building MoneySwitch, a programmable Web3 cloud wallet for AI bots that you host yourself. One payer funds the wallet; each agent gets a separate spending key, with budgets and human approvals enforced before payments are signed. Today it pays compatible USDC/x402 services on Monad and Base.

The new post explains the design and its limits. We'd welcome contributions from developers running their own agents: clearer deployment instructions, reproducible failures and better connection examples are all useful places to start.

Read: https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/

Contribute a PR: https://moneyswitch.dev/contribute/

Try it first: https://moneyswitch.dev/pilot/

## HN Show HN 标题候选与首评结构

作者用途见开头说明；以下纯文本供本人核实事实后自行重写，不作为可直接粘贴的 HN 稿件。

### 标题候选

```text
Show HN: MoneySwitch – A self-hosted Web3 wallet for AI bots
```

提交链接候选：`https://moneyswitch.dev/`。

### 首评候选

```text
I'm building MoneySwitch to manage spending permissions for agents running across different machines.

It is a self-hosted service with one payer's wallet. Each agent gets a separate key with daily, total and per-payment limits, allowed hosts and an approval threshold. Payments at or above that threshold wait for a person; approval does not override the hard caps.

The payment path is currently USDC over x402 on Monad and Base. A seller has to accept a supported payment scheme and chain. It does not pay arbitrary model subscriptions or provide a hosted account for customer deposits.

The server holds a hot wallet, so the server remains trusted. The agents should not have access to its wallet files or database. The suggested first run uses testnet USDC with no monetary value.

I'd appreciate a developer's look at the deployment and agent connection flow, and whether the approval and payment statuses are understandable. Documentation fixes, minimal reproductions and focused PRs are welcome.

Contribution guide: https://moneyswitch.dev/contribute/
Testnet walkthrough: https://moneyswitch.dev/pilot/
Source: https://github.com/dongsheng123132/moneyswitch
```

## 需要提到奖励时，单独补这一句

中文：我们会视试用与反馈情况酌情给予奖励，不承诺固定金额或参与即得；提交或合并 PR 不等于自动获奖。

English: We may offer rewards at our discretion based on trial participation and feedback. No fixed amount or automatic reward is promised, including for submitted or merged PRs.

HN 候选不加这句话。
