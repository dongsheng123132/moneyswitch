# MoneySwitch — Shenzhen Demo Day, auditable bills and verified Base/Solana test payments

日期：2026-10-11，北京时间。

提交状态：**草稿，尚未提交**。当前无法使用 Colosseum 登录会话，也没有平台提交回执。以下中英文正文可用于今日进展或动态；本文件更新不等于平台发布。

## English post

**Today's progress: Shenzhen Demo Day, auditable bills, and live Base/Solana test payments**

Today we're taking MoneySwitch to the Shenzhen offline hackathon Demo Day and inviting developers to test our self-hosted spending gateway for AI agents.

The latest build is deployed on our US server. Agents use a MoneyKey with spending limits, allowed domains and human approvals; signing keys stay on the owner's server. Payment requests can now pin an explicit `network`: an incompatible seller offer fails instead of silently switching to another chain.

We completed **0.01 test-USDC payments on both Base Sepolia and Solana Devnet**: [Base Sepolia transaction](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633) and [Solana Devnet transaction](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet). The Solana payment is settled and independently verified as finalized on-chain. Test tokens have no monetary value; Solana mainnet payments remain disabled.

The deployed billing page puts human review first: separate totals for confirmed mainnet payments and testnet payments, a distinct pending-review notice, and clear amounts, Agent/Key labels and status in each row. On-demand details show the recipient, request and chain transaction. The Key page now presents budget cards with usage meters, active/inactive filters, search and direct links to each Key's bills; the mobile layout keeps amounts readable. This update adds no database migrations or new dependencies.

An agent may add an optional purpose note, or leave it blank. Notes are self-reported, not verified task records. Purposes start hidden, the overview shows only request hosts, and CSV exports omit purposes and full URLs unless explicitly included. These display choices do not restrict administrator access to saved records.

Developers are welcome to test at [app.moneyswitch.dev/keys](https://app.moneyswitch.dev/keys) (administrator sign-in required). [Source and self-hosting instructions](https://github.com/dongsheng123132/moneyswitch). We'd appreciate feedback on key setup, network selection, approvals, budgets and billing.

## 中文动态

今天带 MoneySwitch 参加深圳线下黑客松 Demo Day，也欢迎开发者来测试。

最新版本已部署到美国服务器。每个 AI Agent 使用带支出额度、允许域名和人工审批的 MoneyKey，签名密钥保留在用户自己的服务器。请求现在可以用 `network` 明确指定付款网络；卖家不支持该网络时直接拒绝，不会悄悄换链。

已经在 **Base Sepolia 和 Solana Devnet 各真实完成一笔 0.01 测试 USDC 支付**：[Base Sepolia 交易](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633)、[Solana Devnet 交易](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet)。Solana 付款已结算，并通过独立链上核验确认最终完成。测试币没有货币价值，Solana 主网支付仍未启用。

这次把账单做成了更适合人审核的支出账本：主网与测试网的已付款金额分别汇总，待核对支出单独提醒；明细先展示金额、Agent/Key 与状态，展开后再看收款地址、请求和链上交易。Key 页面改成预算卡片，能直观看到额度占用，支持启用/停用筛选、搜索和直达对应账单，手机也能读清金额。本轮没有新增数据库迁移或依赖。

Agent 可以选填用途，也可以不填，用途是自述备注，不是已核实的任务事实。用途默认隐藏，概览只显示请求域名；CSV 默认省略用途和完整请求地址，主动选择才包含。这些展示选择不限制管理员读取已保存记录。

欢迎通过 [app.moneyswitch.dev/keys](https://app.moneyswitch.dev/keys) 测试（需要管理员登录）。[源码与自托管文档](https://github.com/dongsheng123132/moneyswitch)。欢迎反馈 Key 配置、选链、审批、额度和账单体验。

## 人工测试指引

1. 用现有管理员登录打开 [Key 页面](https://app.moneyswitch.dev/keys)，创建**测试网** MoneyKey。
2. 打开钱包页，复制 **Solana Devnet 那一行的 Solana 地址**，从 [Circle 测试币水龙头](https://faucet.circle.com/) 获取 Devnet USDC。不要使用上方的 EVM `0x` 地址。官方 mint 为 `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`，见 [Circle 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)。测试币没有真实货币价值。
3. 每次请求可显式填写 `network`，例如 Base Sepolia 的 `eip155:84532`，或 Solana Devnet 的 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`；卖家必须提供匹配网络。用途 `purpose` 可留空或写通用备注，避免填机密项目、员工私人任务或完整提示词。
4. 当前公网 `/x402-testnet/check` 是 **Monad 测试付款端点**，不能用它证明 Base 或 Solana 付款成功。Solana 需要接受 x402 v2 exact-SVM 的兼容卖家及独立付款赞助方；本次 Devnet 实付已通过，具体说明见 [Solana 手册](../solana-devnet.md)。
5. 付款后核对账单及对应网络的 explorer 交易。出现不确定状态时不要重复付款，保留账本并等待对账结果。

## 维护区：本次状态（不属于公开正文）

- 美国服务器当前源码与发布镜像对应 `c789255`，容器 healthy；包含账单审核概览、Key 预算卡片、可选用途、严格 `network` 参数和 Solana RPC 修复。本轮只更新界面及付款状态判定，没有新增数据库迁移或依赖。
- 部署前后比对一致：加密钱包、解锁文件、管理员凭据、21 把 Key 和 8 条付款记录完整保留。回滚备份：`/opt/moneyswitch/backups/20261011-130757`；公网 `/keys`、`/bills` HTML 与 6 项资源哈希匹配当前发布包。
- 完整本地构建、回归通过；最终 x402 138 项、Dashboard 232 项通过，Windows/Linux 发布包烟测各 29 项通过。视觉验收使用真实 App SSR 和合成数据，桌面 1440px、手机 390/360px 的金额、完整名称、长 URL 和原生操作菜单无横向溢出；静态截图不宣称 React 交互已通过。
- Base Sepolia 已实际支付 `0.01` 测试 USDC；交易哈希：`0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633`。公开正文只放交易链接，不抄完整钱包地址或余额。
- Solana Devnet 已实际支付 `0.01` 测试 USDC，账单状态 `settled`；独立 RPC 返回 `finalized`，slot `509781446`。交易：`3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu`，用途自述为 `Solana Devnet connectivity test`。
- 已修复 Node 原生 fetch 自动设置请求长度与 SDK 手动 `Content-Length` 重复的问题；通过标准 pnpm 小补丁让原生 fetch 计算 RPC 请求长度。先前的 `failed`、`unknown` 付款记录原样保留，本次成功不会把旧未知记录自动改成成功。
- 新请求明确在签名前失败时标为失败并释放预算；签名可能已生成、证据保存失败或已开始付款请求时仍保留待核对与预算。SDK 重试超时不会释放先前付款的预算。北京时间 11:52:22 的旧 Solana 请求仍为 `unknown/UPSTREAM_ERROR`，缺少可验证证据；12:28:13 的成功付款是另一条记录。本轮部署没有再付款。
- Solana 主网与 Devnet 使用同一派生地址，但美国部署没有开启 Solana 主网支付；无需为了主网额外生成另一地址。
- Colosseum 浏览器控制所需 trusted Node 启动失败，当前拿不到登录会话；这份草稿**尚未提交**，未代发，等待可用登录会话或用户人工发布。
- 后续以实时部署和账本核验为准；下方历史金额、记录数量、Key 数量与制品哈希只描述上一版验收时点。

## 历史部署证据（c712323，保留供维护追溯）

- 源码与发布镜像：`c7123236299a9311f57bbda113274658a2c218d2` / `moneyswitch:c712323`。
- 美国发布目录：`/opt/moneyswitch/releases/c712323`；容器状态：healthy。
- 回滚备份：`/opt/moneyswitch/backups/20261011-105612`，已验证加密钱包及对应解锁文件完整。
- 钱包文件、管理员凭据、16把 Key 的内容哈希保持一致，付款记录仍为2条。
- 新增迁移：`0011_solana_evidence.sql`；仅添加列。
- 启用网络：Monad testnet、Base Sepolia、Monad mainnet、Base mainnet、Solana Devnet；原有默认链仍为 Monad testnet。
- 公网 `/keys` HTML，以及6项 JS/CSS/ICO/PNG/SVG/触屏图标资源，与发布包 SHA256 一致；未鉴权 `/v1/status` 返回401。
- `/favicon.ico` 返回真正的 `image/vnd.microsoft.icon`，图标链接附带新缓存版本号。
- 美国生产容器只读链核验：Devnet genesis匹配，Circle USDC mint已初始化、6位精度，slot `509758579`。
- 验证期间发送的链上付款：**0**。未重置生产管理员令牌，未创建、替换或导入生产钱包。
- 本地完整 `pnpm build`、`pnpm test` 成功；Windows/Linux发布包沙箱验收各29项通过。
- 当时该提交已保存在本地 Git。直接推送远程 `main` 被自动审批拒绝，理由是用户部署授权未明确包含默认分支推送；此条只保留历史情况，不代表本次推送状态。
