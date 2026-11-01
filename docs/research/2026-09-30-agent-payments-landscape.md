# 同类产品调研：给 Agent 发钱 + 桌面端 Agent 配置（2026-09-30）

> 起因：用户问"把 USDC 做成 API Key 会不会太创新""别人的 x402 本地端怎么做"，以及 magpie 是什么。
> 核实程度标记：**✔** = 主会话亲自看过原文（GitHub API / 官方页面）；**○** = 只来自搜索摘要，没有逐页核对。
> 结论只对 2026-09-30 负责；这些产品都在快速迭代，引用到对外材料前再核一次。

## 0. 结论

1. **不是太创新，是撞车。** "每个 Agent 一把带额度的钥匙，超额由钱包拒签、Agent 碰不到私钥"，在 2026 年已经是
   Coinbase、AWS、Ampersend（The Graph 团队）都在做的共识。预算、撤销、审计、签名前检查都不能再当卖点。
2. **我们真正不同的只有三点**：开源 + 自部署（钥匙和账本在自己机器/服务器上）、不需要任何平台账号、原生 Monad。
   第三点只在 Monad 生态里有分量，不是护城河。
3. **桌面端"大脑"（给 Agent 配模型）已经很拥挤**，CC Switch、EchoBird、magpie 都做得很好。
   MoneySwitch 桌面版只做"钱包"那半，大脑那半做兼容，不重做。

---

## 1. 给 Agent 发钱并管额度

| 产品 | 钱包从哪来 / 谁保管 | 额度怎么管 | 链 | 形态 | 核实 |
|---|---|---|---|---|---|
| Coinbase Payments MCP（后续叫 Agentic Wallet MCP） | 邮箱 + 验证码登录，生成嵌入式钱包 | 单次调用上限、单会话上限 | Base、Polygon、Solana | `npx @coinbase/payments-mcp` | ✔ 官方文档 |
| Ampersend（Edge & Node） | Safe 智能账户 + Coinbase CDP 嵌入式钱包，私钥可导出；Agent 的 key 必须由 ampersend 服务端 key 联合签名，服务端执行策略 | 每个 Agent 的日 / 月 / 单笔上限 | FAQ 未写 | SaaS + SDK；beta 期免费；主平台不需要 KYC；FAQ 没提开源或自部署 | ✔ FAQ |
| AWS Bedrock AgentCore Payments | Coinbase 或 Stripe Privy 钱包；Agent 看不到原始凭证，只拿短期 token | 按"支付会话"设上限：金额 + 过期时间，签名前确定性检查 | GA 文章未写（搜索摘要说 Base、Solana ○） | 云服务；x402（含 `upto` 方案）+ MPP | ✔ GA 文章（2026-08-18） |
| BlockRun MCP（开源，约 400 星） | 首次运行自动生成钱包，私钥在 `~/.blockrun/.session`（0600）或系统钥匙串；另有"账户 API Key"模式：刷卡 / 电汇充值，带成员、账本、按 Agent 分额度 | 账户模式按 Agent 委托额度 | Base、Solana | MCP | ✔ GitHub README |
| Stripe Issuing for agents（2026-04-29） | 每个 Agent 一张虚拟卡，钱在 Stripe 金融账户里 | 单笔 / 月度上限、限定商户类别、可冻结 | 不涉及链 | API | ○ |
| Ramp、Brex | 同上，按员工 / Agent 发虚拟卡 | 同上 | 不涉及链 | SaaS | ○ |

补充时间线（○）：Coinbase Payments MCP 2025-10-23 发布；Coinbase Agentic Wallet 2026-02；Ampersend 2026-04 正式发布；
AWS AgentCore Payments 2026-05 预览、2026-08 正式可用。

两点对我们有直接意义：
- **一键生成本机钱包是常规做法**（BlockRun），不需要 Google / 邮箱账号。
- **"个人钱包 + 团队账户 Key"双模式也有人做了**（BlockRun），和我们的个人模式 / 公司模式一一对应。
- Coinbase 用 `npx` 交付本地端，说明 npm 交付对开发者是行业惯例；普通用户仍需要 GUI（见桌面版讨论）。

## 2. 桌面端 Agent 配置工具（"大脑"那半）

| 产品 | 技术栈 | 本地服务 | 规模 / 发布物 | 核实 |
|---|---|---|---|---|
| CC Switch（farion1231/cc-switch） | Tauri：Rust + TypeScript；rusqlite | 有：`src-tauri/src/proxy/server.rs`（axum 本地代理），跑在应用进程内；**不带 Node** | 约 13.8 万星；v3.20.4 出 msi、免安装 zip、dmg、AppImage、deb、rpm | ✔ |
| EchoBird（edison7009/EchoBird） | Tauri + Vite/React；rusqlite | 有：`smart_router/server.rs`（axum，智能路由和故障切换）；**不带 Node**，`tools/` 是各工具的配置资料 | 约 3300 星；v5.8.0 出 exe、msi、dmg、deb、rpm | ✔ |
| magpie（yetone/magpie，MIT） | Go + Wails（系统 WebView），单文件；桌面版 < 15 MB，纯命令行版 7 MB | 有：本地网关 `127.0.0.1:3425`，同时讲 OpenAI Chat Completions、Responses、Anthropic Messages，并在它们之间互相翻译（含流式和工具调用） | 2026-09-23 创建，一周约 2500 星；Windows 版暂未签名；自带后台自动更新 | ✔ README |

### magpie 怎么玩（README 摘要）
- **一屏列出本机所有 Agent 和它们当前的模型**，点一下换模型。菜单栏图标点开是下拉面板，也能开成窗口；
  另有 `magpie tui`（终端界面）、纯命令行、`magpie web`（浏览器里开同一个界面，适合 WSL / SSH 服务器）。
- **所有 Agent 指向同一个本地网关**，模型统一写成 `provider/model`，例如
  `magpie codex deepseek/deepseek-chat`、`magpie claude moonshot/kimi-k2.5`。Agent 本身不再持有各家的 key 和地址。
- **加供应商只填一个 key**：`magpie provider add deepseek sk-…`。内置预设很多，国内的有 DeepSeek、Kimi、GLM、
  MiniMax、阶跃、通义、百度千帆、腾讯云、华为云、火山方舟、硅基流动、ModelScope 等；自定义供应商给 `url=` 和 `key=`。
- **已登录的订阅也能当供应商**：Claude Code、Codex（ChatGPT）、Copilot 等的登录态，可以给别的 Agent 用。
- **改配置只动那一个字段**，保留注释、顺序和缩进，原子写入；**Profiles** 一键保存 / 切换全部 Agent 的设置。
- **加密备份**：`magpie backup` / `magpie restore`，连同"library"（指令集、MCP 服务器、skills）一起搬到新机器。
- 安装：官网 usemagpie.ai 下载，或 `curl -fsSL https://usemagpie.ai/install.sh | sh`，或 `go install github.com/yetone/magpie@latest`。

### 这一组给我们的结论
- 三个都在**应用自己的进程里**起本地 HTTP 服务，都没有附带 Node。"应用开着就有个本地服务"是这类产品的常态。
- 模型管理这块竞争激烈、做得也好。**MoneySwitch 桌面版不做大脑**，只做钱包；大脑那半做兼容：
  - **作为 magpie 的自定义供应商**：MoneySwitch 已有 OpenAI 兼容网关（`/v1/chat/completions`、`/v1/models`，
    用 `mk_live_` key），理论上 `magpie provider add MoneySwitch url=http://127.0.0.1:4020/v1 key=mk_live_…`
    就能让 Agent 的模型调用走 USDC 付费。**未实测。**
  - **MoneySwitch MCP 放进 magpie 的 library**（它管理 MCP 服务器）。**未实测。**
- 如果以后真要做原生壳，magpie 的 Go + 系统 WebView 单文件是最轻的路线；但我们的核心是 TypeScript，
  不为这个重写。

## 3. 传统做法（不用加密货币）

- **公司给员工或 Agent 发钱**：每人 / 每个 Agent 一张虚拟卡，设单笔和月度上限、限定商户类别（Stripe Issuing、Ramp、Brex）。
- **API 行业**：每个供应商注册一个账号、拿一把 key、绑卡月结。国内对应的是 new-api 的"令牌 + 额度"（虾盘云就是）。
- **MoneyKey ≈ new-api 令牌**，区别是这把令牌能付给任何 x402 卖家，不只一家供应商。

## 4. MoneySwitch 的差异

**是差异（可以写进 pitch）：**
1. **开源、自部署**：服务端 AGPL-3.0，接入层 Apache-2.0；钱包私钥和账本不离开你自己的机器或服务器。
   对比：Coinbase / AWS 是托管；Ampersend 要它的服务端 key 联合签名。
2. **不需要平台账号**：跑起来不用在任何平台注册。对比：Coinbase 要邮箱登录，AWS 要 AWS 账号，Ampersend 要它的账号。
3. **原生 Monad**：主网已经真实付过 Nansen。对比：Coinbase Payments MCP 支持 Base、Polygon、Solana（✔）。

**有，但不要说成独有的（没查到别家有没有）：**
- 多级子 Key（公司 → 员工 → Agent，子额度不超过父，撤销级联）。
- 卖方收费站（Ampersend 也能给 Agent 收款；Coinbase 的 x402 也有卖方中间件）。

**不再是卖点：**
- "把 USDC 做成 API Key"、按 Agent 预算、撤销、审计、签名前检查、Agent 不碰私钥——大家都有。
- "模型和钱一起配"——magpie、CC Switch 在模型这块做得更好。

## 5. 风险

1. **撞车**：评委大概率认识 Coinbase、AWS、Ampersend。对外材料不能暗示我们是第一个，要主动写清区别。
2. **能买的东西少**：x402 卖家本来就不多，Monad 上更少（这也是做灵签、演示买 Nansen 的原因）。
3. **大厂免费**：Ampersend beta 期免费，Coinbase / AWS 有生态绑定。我们的空间在"必须自己保管、或者开不了这些账号"的用户。

## 来源

- Coinbase Payments MCP 文档：https://docs.cdp.coinbase.com/payments-mcp/welcome ✔
- Coinbase 发布页：https://www.coinbase.com/developer-platform/discover/launches/payments-mcp （403，未能直接打开）
- PYMNTS，Coinbase Agentic Wallet：https://www.pymnts.com/cryptocurrency/2026/coinbase-debuts-crypto-wallet-infrastructure-for-ai-agents/ ○
- Ampersend FAQ：https://ampersend.ai/faq ✔ ；文档：https://docs.ampersend.ai/
- Bankless，The 19-Cent Agent：https://www.bankless.com/x402-big-week ○
- AWS AgentCore Payments GA：https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-payments-is-now-generally-available-enabling-agents-to-transact-safely-and-autonomously-at-scale/ ✔
- Coinbase × AWS：https://www.coinbase.com/blog/introducing-amazon-bedrock-agentcore-payments-powered-by-x402-and-coinbase ○
- BlockRun MCP：https://github.com/BlockRunAI/blockrun-mcp ✔
- Stripe Issuing for agents：https://docs.stripe.com/issuing/agents ○
- Ramp，Virtual cards for AI agents：https://ramp.com/blog/virtual-cards-for-ai-agents ○
- CC Switch：https://github.com/farion1231/cc-switch ✔
- EchoBird：https://github.com/edison7009/EchoBird ✔
- magpie：https://github.com/yetone/magpie ✔ ；官网 https://usemagpie.ai
