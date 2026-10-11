# MoneySwitch — Shenzhen Demo Day and Solana Devnet deployment

日期：2026-10-11，北京时间。

提交状态：**待提交**。本机浏览器控制工具启动失败，备用云浏览器没有 Colosseum 登录会话；尚未取得平台提交回执。以下正文可直接用于今日进展或动态。

## English post

**Today's progress: Shenzhen Demo Day, US deployment, and Solana Devnet**

Today we're taking MoneySwitch to the Shenzhen offline hackathon Demo Day and inviting developers to test our self-hosted spending gateway for AI agents.

We deployed the latest build to our US server and enabled Solana Devnet alongside the existing Monad and Base networks. Agents use a MoneyKey with spending limits, allowed domains and human approvals; signing keys stay on the owner's server. The Solana integration uses the official x402 exact-SVM SDK and an independent Ed25519 address derived from the encrypted recovery phrase. Signed payment evidence persists across restarts, and uncertain payments retain their budget reservation until matching finalized chain evidence resolves them.

The build and automated tests passed, including 29 packaged-server acceptance checks on both Windows and an isolated Linux container in the US. We verified the live HTTPS deployment, Devnet RPC and Circle's test-USDC mint, preserved the existing wallet and keys, and fixed the browser tab icon.

We're now preparing a funded manual Solana Devnet payment test. Deployment is complete; a successful live Solana settlement has not yet been recorded. Solana mainnet is not enabled.

Developers are welcome to test: https://app.moneyswitch.dev/keys (administrator sign-in required). Source and self-hosting instructions: https://github.com/dongsheng123132/moneyswitch. We'd appreciate feedback on key setup, approvals, budgets and billing.

## 中文动态

今天带 MoneySwitch 参加深圳线下黑客松 Demo Day，也欢迎开发者来测试。

最新版本已部署到美国服务器，在原有 Monad、Base 支持旁启用了 Solana Devnet。每个 AI Agent 使用带支出额度、允许域名和人工审批的 MoneyKey，签名密钥保留在用户自己的服务器。Solana 接入采用官方 x402 exact-SVM SDK 和独立 Ed25519 地址，签过名的付款证据会持久保存，不确定付款在找到匹配的最终链上证据之前继续占用额度。

构建和自动测试通过，Windows 与美国服务器的独立 Linux 容器各通过29项发布包验收。已核验公网 HTTPS 页面、Devnet RPC 和 Circle 测试 USDC mint；原有钱包和 Key 保留，浏览器标签图标也已修复。

接下来进行有测试币的人工 Solana 付款验证。当前完成的是 Devnet 功能部署，尚未记录成功的 Solana 链上结算；Solana 主网尚未启用。

测试入口：https://app.moneyswitch.dev/keys （需要管理员登录）。源码与自托管文档：https://github.com/dongsheng123132/moneyswitch 。欢迎反馈 Key 配置、审批、额度和账单体验。

## 人工测试指引

1. 用现有管理员登录打开 https://app.moneyswitch.dev/keys ，创建**测试网** MoneyKey。
2. 打开钱包页，复制 **Solana Devnet 那一行的 Solana 地址**，从 [Circle 测试币水龙头](https://faucet.circle.com/) 获取 Devnet USDC。不要使用上方的 EVM `0x` 地址。官方 mint 为 `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`，见 [Circle 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)。测试币没有真实货币价值。
3. 测试 Solana 付款需要接受 x402 v2 exact-SVM 的兼容卖家，其 `extra.feePayer` 应由独立付款赞助方提供；把卖家域名加入 Key 允许列表。付款、拒绝和人工审批的具体调用见 [Solana 手册](../solana-devnet.md)。
4. 当前公网 `/x402-testnet/check` 是 **Monad 测试付款端点**，不能用它证明 Solana 付款成功。仓库里的 Solana live harness 是独立、本地进程内卖家，尚未成为公网 Solana 试付端点。
5. 付款后核对账单和 `?cluster=devnet` 的 Solana explorer 交易。出现不确定状态时保留账本，等待对账结果。

## 部署证据

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
- 此提交已保存在本地 Git。直接推送远程 `main` 被自动审批拒绝，理由是用户部署授权未明确包含默认分支推送；等待用户答复授权问题。
