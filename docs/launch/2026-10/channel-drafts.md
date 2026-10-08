# MoneySwitch 渠道短稿

以下为供本人审阅、修改和发布的草稿。链接指向本次准备的新页面，需等网站上线后再发。奖励视试用与反馈情况酌情给予，具体形式与标准另行说明，不承诺参与即得或固定金额。

## 微信群 / 定向邀请

最近在做一个叫 MoneySwitch 的开源项目，想找一些正在用多个 AI Agent 的朋友试一试。

起因很具体：电脑上跑 Codex，另一台机器跑 Claude Code，云端还有自己的 Agent。它们需要付费调用服务时，我想在一个地方管额度和审批，不想在每个运行环境里分别管理钱包私钥。

MoneySwitch 是可云自托管的可编程多 Agent 支出钱包：自己部署一台钱包服务，每个 Agent 领一把有额度的 MoneyKey，达到审批线找人批，花完能查账，也能单独撤销 Key。

现在支持的是 USDC / x402 付费服务。这轮先用没有真实价值的测试币，体验两把 Key、付款、审批和账单。需要自己部署；还没有公开注册的托管版。

如果你也在多个设备上用 Agent，欢迎试试，告诉我哪里卡住、有没有一个真实任务会用到它。不需要转发或好评，没跑通也欢迎反馈。我们会视试用与反馈情况酌情给予奖励，具体形式与标准另行说明。

试用步骤：https://moneyswitch.dev/pilot/zh/

## 朋友圈短版

电脑上一个 Codex，服务器上一个 Claude Code，云端再跑几个 Agent——这些 AI 花钱，能不能在一个地方管？

我在做 MoneySwitch：可云自托管的多 Agent 支出钱包。每个 AI 一把有额度的 Key，达到审批线由人决定，付款记录集中查看。

想找正在使用 Agent、愿意自部署的朋友试一轮。先用测试币，不用主网资金；反馈真实的卡点就好，不要求转发或好评。会视试用与反馈情况酌情给予奖励。目前支付范围是受支持的 USDC / x402 服务。

详情：https://moneyswitch.dev/pilot/zh/

## 小红书草稿

标题：多台电脑上的 AI，花钱能不能一起管？

我在做一个自己想用的小工具：MoneySwitch。

如果你的电脑上有 Codex，另一台机器有 Claude Code，云端还跑着 Agent，你可能也想过：它们需要购买数据或调用付费接口时，预算到底怎么管？

我的做法是把钱包放在自己的服务器上，给每个 Agent 发不同额度的 Key。能花多少、哪些网站能访问、多少金额需要人批准，都在一处设置；用完可以查账、撤销 Key。

目前还是早期版本，支付支持 USDC / x402 接口，需要自行部署，不是所有 AI 订阅都能付。想邀请有这个场景的开发者用测试币试一遍，尤其想听哪里不好用。

会视试用与反馈情况酌情给予奖励，具体形式与标准另行说明。不要求好评，安装就卡住了，也是一条有用反馈。

项目：moneyswitch.dev

编辑备注：发布前确认所选发布位置的外链和话题规则；配图宜用实际首页、两个 Key 的脱敏界面、一次审批和对应账单。不要拍入 Key、PIN、恢复词或管理员链接。

## 知乎发布安排

主文用 `docs/blog/one-wallet-many-agents.zh.md`，它从多设备 Agent 的实际管理问题切入，再解释钱包与 MoneyKey 的区别和服务端边界。文末已有试用链接。

招募进展可单独使用 `docs/blog/agent-wallet-trial.zh.md`。等有真实首轮结果，再写“几个人试了、在哪一步卡住、我们怎么改”，不要提前把假设写成用户案例。

## English community introduction

I've been building MoneySwitch, an open-source spending wallet for AI agents that you run on your own server.

The use case is several agents across a laptop and cloud machines, spending from one wallet I control. Each gets a separate budget-limited key. MoneySwitch checks limits before signing, asks a person to approve payments at or above a configured threshold, and records the payment outcome.

It currently pays supported USDC / x402 APIs on Monad and Base. It doesn't pay arbitrary subscriptions, and it isn't a hosted account service. The first trial uses testnet USDC with no real value.

I'd like feedback from people who already run multiple agents or self-host their tools: can you connect two agents, follow an approval, and understand the bill? A failed setup is useful feedback too. We may offer discretionary rewards based on trial participation and feedback; details will be announced separately, with no guaranteed reward or fixed amount.

Trial guide: https://moneyswitch.dev/pilot/
Source: https://github.com/dongsheng123132/moneyswitch

编辑备注：此段适用于允许项目介绍、允许此类草稿的社区，不用于 HN。选择社区后再核对具体规则与内容相关性。

## 英文长文

`docs/blog/one-wallet-many-agents.md` 可用于独立博客或开发者博客；`docs/blog/agent-wallet-trial.md` 是招募配套。转载时保留项目归属、当前限制和试用入口。如果平台支持 canonical URL，主文可指向官网对应文章页；实际发布行为需由你执行或另行明确授权。

## 试用后的跟进问题（由你发）

1. 最近一次让 Agent 购买数据或服务，具体买了什么，原来怎么付？
2. 这次从开始到第一笔测试付款，卡住的是哪一步？
3. 哪个规则会让你愿意继续用，哪个配置是多余的？
4. 接下来一周有没有一个具体任务会再次使用？如果没有，为什么？

只记录对方自愿提供的反馈；不要收集恢复词、密钥或整份服务器日志。
