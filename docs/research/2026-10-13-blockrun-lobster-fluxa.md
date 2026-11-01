# BlockRun、Lobster.cash、FluxA 与 MoneySwitch 的结合点

调研日期：2026-10-13。依据三家官方主页、文档和官方仓库，以及本地 `SPEC.md`、Money API、README 与 10 月 6 日定位草案。本次只读调研，未安装、注册、充值、付款或进行端到端集成测试。

## 核心判断

- **BlockRun：近期最适合做实际支付供给方示例。** 它提供模型与工具，MoneySwitch 控制组织内各 Agent 的购买权限。
- **Lobster.cash：可参考的支付授权体验，以及未来钱包、虚拟卡执行通道。** 当前 MoneySwitch 与其公开 Solana 路线不直接兼容。
- **FluxA：最直接的竞争产品。** 多 Agent、预算、允许主机、任务用途授权和账本已与我们的主线重叠。

建议定位：**MoneySwitch 是组织可自行部署的多 Agent 支出控制器：每个 Agent 用独立 MoneyKey，在权限内购买 x402 服务，超出审批线交给人，支出和支付状态由组织统一核对。**

这里的重点是部署和治理归属、授权层级及完整支付处理。额度、审批、私钥不交给 AI、账本都已有其他产品覆盖，不能单独当成独有功能。任务用途审计仍是规划。

## MoneySwitch 当前能力与边界

本地当前提交为 `0600d4b`（v0.7.6）。有效规格为 `SPEC.md` v0.7；10 月 6 日云钱包定位文档是方向草案。

已实现：一个部署只花部署者自己的钱；本地加密共用钱包；每 Agent 一把 MoneyKey；日额度、总额度、单笔上限、允许域名、审批线、过期与撤销；父子 Key 后端；`POST /v1/fetch` 代理目标请求；Base/Monad 主网与测试网；EIP-3009 USDC 授权；`charged: yes/no/maybe`；未知支付禁止自动重试和事后对账。

当前不支持 Solana、虚拟卡、外部钱包、模型网关或商户收款。`task_id`、付款用途 `purpose`、按任务审计，以及子 Key 管理界面尚未实现。后续钱包 adapter 和卡支付属于新的产品范围，需先更新规格。

## 1. BlockRun：Agent 去哪里购买模型与工具

它把多家 LLM、图片/视频/语音、搜索、数据等服务汇集成 API，并以 x402 按调用收费。ClawRouter 是开源客户端模型路由器。参考 [官网](https://blockrun.ai/)、[ClawRouter](https://github.com/BlockRunAI/ClawRouter)。

### 最小结合方式

`Agent → MoneyKey → MoneySwitch /v1/fetch → BlockRun → 返回内容与支付收据`

候选目标接口：`POST https://blockrun.ai/api/v1/chat/completions`。BlockRun 的 Base 支付流程使用 `exact`、`eip155:8453`、Base USDC、EIP-3009/EIP-712 授权及 `PAYMENT-SIGNATURE`，与 MoneySwitch 现有路径在文档层面匹配。优先做非流式、短文本、小金额请求；以实际 402 报价为准。

参考：[Payment Flow](https://blockrun.ai/docs/x402/payment-flow)、[Chat Completions](https://blockrun.ai/docs/api-reference/chat-completions)、[机器发现 manifest](https://blockrun.ai/.well-known/x402)。

### 后台 API Key 与 x402 是两个入口

用户后台 `user.blockrun.ai` 创建的 `brk_live_…` 是账户计费凭证：使用 `https://api.blockrun.ai/v1`，账户余额通过信用卡或电汇充值。x402 使用另一个入口 `https://blockrun.ai/api/v1`，直接从调用方自己的 Base USDC 钱包按次结算，无需创建账户或后台 API Key。x402 付款动作由客户端或 SDK 处理，不需要先在创建 Key 的页面连接钱包。参考 [用户入口说明](https://user.blockrun.ai/)、[Enterprise API](https://blockrun.ai/docs/getting-started/enterprise-api)、[钱包设置](https://blockrun.ai/docs/getting-started/wallet-setup)。

**2026-10-13 实际报价检查：** 向 `https://blockrun.ai/api/v1/chat/completions` 发送无认证、无支付签名的 POST，请求 `openai/gpt-5.5`、一条 `hello` 消息、`max_tokens: 16`、非流式。接口返回 HTTP 402，`PAYMENT-REQUIRED` 中 `x402Version: 2`、`scheme: exact`、`network: eip155:8453`、Base 原生 USDC 合约、`amount: 2000`（0.002 USDC）。响应体明确写 `This endpoint requires x402 payment`。本次未签名、未付款，确认了实际 x402 报价入口，仍未验证付费后的完整链路。

这条路线保留 MoneySwitch 的本地钱包与政策执行，不需要把 BlockRun SDK 的钱包私钥参数交给 Agent。需要实测请求与响应头、报价、签名、审批重发及结算状态后，才能宣称接通。流式输出和异步媒体任务单独验证。

### 已有重叠

ClawRouter 已支持单笔、小时、日、会话金额上限，以及收款方、网络、资产策略；企业 API 有日消费上限、按 key/model/endpoint 的统计和逐请求账本。参考 [ClawRouter 配置](https://github.com/BlockRunAI/ClawRouter/blob/main/docs/configuration.md)、[Enterprise API](https://blockrun.ai/docs/getting-started/enterprise-api)。

因此要强调组织内独立授权、父子 Key、人工审批、统一账本及跨供给方支付状态处理，不能说 BlockRun 没有额度和审计。

### 最值得参考

- 用具体任务展示购买价值：搜索、模型调用、视频生成。我们的演示同时展示哪个 Agent 有权限、何时被拦截、付款后怎么核对。
- 在购买前说明价格，购买后给收据；收到内容与已完成链上结算分别判断。
- x402 聊天以预先签署的估算报价结算，不应把它写成精确 token 实耗账单。

其 [平台嵌入方案](https://blockrun.ai/platforms) 已覆盖白标与转售等路径。MoneySwitch 当前应选择组织自付路径，维持现有规格边界。

## 2. Lobster.cash：把人类授权的钱包与卡支付交给 Agent

Lobster 是 Crossmint 的 Agent 支付产品。Agent 找到要买的东西、请求资金、人类批准钱包或卡授权、Agent 完成购买。覆盖域名、订阅、实体商品和 x402 接口。参考 [官网](https://www.lobster.cash/)。

其底层 Crossmint 平台提供 [Agent Cards](https://docs.crossmint.com/agents/cards/overview)、[Agent Wallets](https://docs.crossmint.com/agents/wallets/overview)、[Agent Checkouts](https://docs.crossmint.com/agents/checkouts/overview)。限额、授权、撤销、支付状态和收据已有相应产品支持。

### 结合方式与限制

后续可以把 Crossmint 类服务放在支付执行层：MoneySwitch 先执行组织的 MoneyKey 规则，再调用受限钱包或卡权限完成付款，最后统一核对账本。这是候选架构，当前无 adapter。

Lobster 的公开 [skill 兼容指南](https://www.lobster.cash/docs/skill-compatibility-guide) 明确 x402 路线为 Solana、USDC、PDA 智能钱包；当前 MoneySwitch 为 EVM/EIP-3009，不能直接宣布兼容。Crossmint 另有 [Base x402 SDK 示例](https://docs.crossmint.com/agents/payment-flows/x402)，应与 Lobster 产品的公开支持范围分别判断。

所有外部签名或卡凭证只能由 MoneySwitch 受控执行路径持有；让 Agent 直接使用另一个支付 SDK，会让 MoneyKey 的预算检查失去覆盖。

### 最值得参考

- 授权用购买对象和金额表达，例如“为这个域名授权 20 美元”，让人看懂一次授权的范围。
- 有效期、撤销和最终支付状态成为授权体验的一部分。
- 建立清晰兼容指南与实际验证过的服务目录。其 [生态目录](https://www.lobster.cash/skills) 已列出 BlockRun，表明模型供给和支付入口可以组合。

卡路线涉及可用地区、发行卡支持和生产开通条件；不同卡凭证路线的限额执行位置不同，不能一概宣称所有路径都由卡网络强制限额或都不暴露原始卡信息。参考 [卡 quickstart](https://docs.crossmint.com/agents/cards-quickstart)。

## 3. FluxA：任务授权与 Agent 支付全栈

FluxA 的公开产品包括 AgentWallet、Intent-Pay/Financial Harness、AgentCard、AgentMarket、AgentCharge。参考 [官网](https://fluxapay.xyz/)、[钱包文档](https://docs.fluxapay.xyz/wallet/)。

其钱包已覆盖多 Agent 身份、额度、审批与账本；意图授权包含用途、预算、期限、允许主机，人类签一次后，范围内的多笔消费自动执行。公开接口支持创建与查询 mandate、查剩余额度及获取付款授权。参考 [Mandates](https://docs.fluxapay.xyz/wallet/http-mandates.html)、[自动政策](https://docs.fluxapay.xyz/wallet/auto-policies.html)。

### 竞争关系

这是最强重叠。仅靠“多个 Agent 共用钱包”“每个 Agent 有额度”“按任务用途付钱”不足以解释 MoneySwitch 的独立价值。

我们可以强调组织自己部署服务、掌握政策与账本、独立 MoneyKey 和委托层级、人工审批及未知支付处理。FluxA 的 [官方 MCP/CLI 客户端](https://github.com/FluxA-Agent-Payment/FluxA-AI-Wallet-MCP) 调用远端钱包执行签名和政策；本次未看到等效自托管服务端的公开交付，不据此断言其没有其他企业方案。

### 两条候选结合路线

1. **消费其 x402 商户服务。** 保留 MoneySwitch 本地钱包，购买 FluxA AgentCharge/Monetize 服务。[Payment Links API](https://docs.fluxapay.xyz/wallet/http-payment-links.html) 有 Base/Base Sepolia USDC 路线；需验证具体头、版本、报价和结算行为。
2. **以后增加远端钱包 adapter。** MoneySwitch 先执行组织政策，再调用 FluxA 的 eligible/payment 接口取得授权；处理双层额度、撤销、超时和对账。[付款 API](https://docs.fluxapay.xyz/wallet/http-x402-v3-payment.html)。当前没有该能力。

### 最值得参考及事实边界

- 参考“一次授权整个任务”的生命周期：任务预算、期限、允许对象、撤销、累计支出及收据。
- 用途说明只是 Agent 的自报线索，不能自动成为可信授权。真正付款仍靠确定性额度、允许对象及人类授权约束。FluxA 的语义风控营销能力本次未实测。
- AgentCard 主站标 LIVE，但 [具体卡页面](https://fluxapay.xyz/agent-card) 仍有 Join waitlist；不能据此认为发卡 API 随时可接。
- 钱包的 intent mandate 覆盖多笔消费；AEP2 payment mandate 是每笔一次性付款凭据。二者不同。
- AEP2 的即时授权、延后批量结算属于协议设计。当前 [Payment Link 接入指南](https://docs.fluxapay.xyz/wallet/payment-guide-payment-link.html) 仍要求等 `settlementStatus=settled` 再履约，不能把协议宣传套到所有现行产品。
- API 名称中的 `x402V3Payment` 不代表已验证为行业统一的 x402 v3 标准。

## 建议顺序与给评委的表达

1. **近期展示真实用途。** 先验证 MoneySwitch 经 Base 支付 BlockRun 的一个短文本接口；用两个 Agent 展示额度内成功、超额度拒绝、审批线触发和账本核对。现有 Monad/Nansen 示例继续说明 Monad 使用价值，BlockRun 是补充供给。
2. **补任务层。** 下一步把 task_id、用途、委托层级和支付收据关联起来，再考虑任务级预算及一次授权多次消费。任务备注本身不构成安全控制。
3. **按需求扩大支付覆盖。** 外部钱包或虚拟卡接入需要先调整规格，再验证，属于后续路线。

10 月 6 日定位草案中“唯一自托管 + 任务审计 + x402”“这个组合没人占”的表述，不能继续作为未经验证的比赛主张。任务审计尚未实现，FluxA 已有用途授权。应换成明确的目标用户、部署形态和可观察行为。

给评委的表达建议：

> 我们调研了这三家。BlockRun 提供 Agent 能购买的模型与工具，Lobster 扩大支付方式，FluxA 已经提供任务授权的钱包体系。MoneySwitch 选择组织可自部署的支出治理：给多个 Agent 独立 MoneyKey，让组织控制预算、审批与账本。现阶段支持 Base/Monad 的 x402；BlockRun 是适合验证的供给方，任务审计与其他支付通道是后续方向。

以上是产品与技术分析，不代表三家已与 MoneySwitch 达成合作或完成接口集成。
