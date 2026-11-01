# 三个平台的服务目录与 BlockRun 首次试付

核验日期：2026-10-13。本次读取官方目录与文档，并向 BlockRun 发出无认证、无支付签名的请求检查报价。未付款，未验证付费后的内容交付。

## 三者分别提供什么

| 平台 | 自己提供的服务 | 用户可买到什么 |
|---|---|---|
| BlockRun | 多供应商模型与工具 API 网关；x402 按次计费 | 模型回答、搜索与网页内容、数据、图片、视频、音频、代码沙箱等 |
| Lobster.cash | 钱包与虚拟卡授权、支付执行、支付结果；兼容 skill 导航 | 通过第三方服务购买模型/API，通过卡支付完成支持的网页结账 |
| FluxA | AgentWallet、AgentMarket、AgentCharge、AgentCard | 第三方模型/API/数据/技能市场；钱包付款；商户收款。卡页面仍有 waitlist |

参考：[BlockRun 服务目录](https://blockrun.ai/services)、[Lobster](https://www.lobster.cash/)、[FluxA](https://fluxapay.xyz/)。

## BlockRun 目录

实际公开 `GET https://blockrun.ai/api/v1/models` 返回 115 条。目录可见不代表本次已验证各上游服务成功交付。

| 类别 | 代表服务 | 用途 |
|---|---|---|
| 文本、推理、代码、视觉 | OpenAI、Claude、Gemini、DeepSeek 等 | 问答、代码分析、文档处理、看图；按模型及 token 定价 |
| 搜索与网页 | Exa 搜索/正文提取、Grok 实时搜索 | 研究、读网页、新闻检索；Exa 与 Grok 搜索为不同接口和价格 |
| 图像 | CogView、GPT Image、Nano Banana | 生图、改图、融合；按图片或模型计费 |
| 视频 | Seedance、Sora、Grok Imagine | 文生/图生视频；部分是异步提交与轮询 |
| 语音、音乐、音效 | ElevenLabs、MiniMax Music | TTS、旁白、声音效果、音乐 |
| 金融与链上数据 | 市场价格、Predexon、DefiLlama、多链 RPC | 行情、预测市场、TVL、链状态查询 |
| 计算环境 | Modal Sandbox | 创建隔离环境、执行代码、查看结果 |
| 电话与链工具 | Phone & Voice、0x | 外呼/号码、DEX 报价及交换相关接口；部分免费、部分付费，另有操作权限要求 |

参考：[模型目录](https://blockrun.ai/models)、[服务目录](https://blockrun.ai/services)。目录中部分条目为免费或需账户 Key 的服务，不能把每一项都统称付费 x402。VC/Funding Data 标 Soon，未列为当前可买服务。

## 已读到实际报价的五个试付

以下全部返回 HTTP 402、x402 v2、`scheme: exact`、Base 主网 `eip155:8453`、原生 Base USDC。价格是这些具体参数在本次请求中的报价，付款仍应遵守当次 402 报价与 MoneyKey 规则。

| 顺序 | 服务 | 具体参数 | 本次报价 | 建议 max_price |
|---|---|---|---|---|
| 1 | 短文本 | `openai/gpt-4o-mini`，32 个最大输出 token | 0.002 USDC | 0.003 |
| 2 | 短语音 | ElevenLabs Flash，`Hello MoneySwitch!` | 0.002 USDC | 0.003 |
| 3 | 一页网页正文 | Exa contents，`https://www.x402.org` | 0.003 USDC | 0.004 |
| 4 | Base 区块号 | RPC `eth_blockNumber` | 0.003 USDC | 0.004 |
| 5 | 一张小图 | `zai/cogview-4`，512×512，1 张 | 0.01675 USDC | 0.02 |

五项本次报价合计 0.02675 USDC。建议先只执行第 1 项，核对服务响应、扣款状态及交易号后，再逐项试其他服务。

逐项的 MoneySwitch `/v1/fetch` JSON 请求体保存在同目录 `2026-10-13-blockrun-test-requests.json` 的 `cases[].moneySwitchFetch`。认证使用已经配置好的 MoneyKey，不把完整 Key 写进报告或请求样例。

### 试付条件

- MoneySwitch 实例启用了 Base 主网，并使用主网 MoneyKey；钱包的 Base 链上有 USDC。Monad 的余额不能支付 Base 报价。
- Key 的允许域名包含 `blockrun.ai:443`；不包含时走现有新域名审批流程。金额若达到审批线，同样由人审批。
- 请求发给自己的 MoneySwitch `POST /v1/fetch`，不是账户计费入口 `api.blockrun.ai`。不用 BlockRun 后台的 API Key。
- 成功时核对 MoneySwitch 的 `http_status`、服务响应、`charged`、`payment.amount` 和交易号。上游 `202` 表示任务仍在执行，应按照上游说明查询任务完成状态。
- 出现 `payment_unknown` 或 `charged: maybe` 时，停止自动重试，等待对账。付款完成前的 402 报价不能作为成功交付证据。

### 可直接交给已有 MoneySwitch Agent 的第一笔指令

> 用你已经配置的 MoneySwitch MoneyKey，只执行这一个测试：POST 到 BlockRun 的 `https://blockrun.ai/api/v1/chat/completions`，模型 `openai/gpt-4o-mini`，用户消息 `Reply only: MoneySwitch payment test OK`，`max_tokens: 32`，`stream: false`。通过 MoneySwitch `/v1/fetch` 调用，`max_price: "0.003"`。需要审批时按现有流程给我审批链接；超过价格上限时停止，不扩大预算；支付结果未知时停止，不自动重试。返回服务内容、扣款状态、金额及交易号。

### 测试网情况

官方 SDK 文档列出 `https://testnet.blockrun.ai/api`、Base Sepolia、`openai/gpt-oss-20b` 等测试模型。本机实际读取测试网模型目录时 SSL 连接失败；无法确认当前可用，不把它作为已经验证的试付入口。[官方测试网说明](https://blockrun.ai/docs/sdks/typescript)

### 对应接口说明

- [聊天](https://blockrun.ai/docs/api-reference/chat-completions)
- [语音](https://blockrun.ai/docs/api-reference/text-to-speech)
- [Exa](https://blockrun.ai/docs/api-reference/exa-search)
- [RPC](https://blockrun.ai/docs/api-reference/multi-chain-rpc)
- [图片](https://blockrun.ai/docs/api-reference/image-generation)

## Lobster.cash 的服务

自己提供钱包或虚拟卡的授权与支付流程；官网列出域名、订阅、实体商品、x402 API 等场景。具体商家是否能成交仍需验证。

其 [skills 目录](https://www.lobster.cash/skills) 是第三方兼容服务导航，列有 BlockRun（模型/图像）、Purch（商品/购物车）、Lando（订阅）、OpenTask/Seedstr（任务市场）、Clawpay（支付请求与交付）。模型、购物搜索和任务交付由这些第三方提供。

公开 [x402 兼容指南](https://www.lobster.cash/docs/skill-compatibility-guide) 要求 Solana USDC 与 PDA 钱包。当前 MoneySwitch 的 EVM 路线不能直接视为兼容。

## FluxA 的服务

| 产品 | 服务 |
|---|---|
| AgentWallet | 钱包、授权多个 Agent、预算/期限/允许主机、审批、交易记录、付款 API/MCP/CLI |
| AgentMarket | 查找和购买第三方模型、收费 API、数据及技能/组合工作流 |
| AgentCharge | 给 API 定价、支付链接、订单查询、Agent 之间付款、退款 |
| AgentCard | 一次性虚拟卡或单次 Visa 凭据，用于传统网页结账；页面仍有 Join waitlist |

AgentMarket 实际目录可在 [Monetize 域名](https://monetize.fluxapay.xyz/) 读取，页面仍称 AgentMarket。可见：

- 模型：Qwen、Doubao、GLM 等商家的模型入口。
- 图像与视频：Kling、Seedance、Nano Banana、GPT Image。
- 搜索：Exa、网页抓取、新闻、YouTube 视频与字幕研究。
- 社交与电商数据：小红书、Reddit、YouTube、淘宝天猫、京东、Amazon、1688 等搜索/详情/评论。数据服务不能直接当成实物代购。
- 金融与旅行：CoinGecko、Alpha Vantage、酒店及旅行信息/预订服务目录。
- Oneshot Skill：创作者把多个 API 组合成可运行工作流；本次未可靠核实独立技能目录的具体在售名称。

[Kling 详情](https://monetize.fluxapay.xyz/marketplace/apis/kling-video-generation) 显示文生视频、图生视频两个 Active 接口与 0.10 USDC/调用；只是目录报价，本次未验证付款及视频交付。其他目录同样不能当成已实测可用。

参考：[模型页](https://monetize.fluxapay.xyz/marketplace/models)、[买方指南](https://docs.fluxapay.xyz/monetize/buyer-browse.html)、[接口参考](https://docs.fluxapay.xyz/monetize/buyer-api.html)、[钱包](https://docs.fluxapay.xyz/wallet/)、[AgentCharge](https://fluxapay.xyz/agent-charge)、[AgentCard](https://fluxapay.xyz/agent-card)。

FluxA 市场服务可能额外要求 Agent ID 或 JWT，购买前分别检查网络、签名方案和身份要求，不因目录写 x402 就宣称 MoneySwitch 已兼容。
