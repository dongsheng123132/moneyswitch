# MoneySwitch 的账号、钱包与 x402 边界

2026-10-03，基于当前代码与 Coinbase 官方实现。以下外部钱包接入是设计建议，尚未实现。

## 三个概念

| 概念 | 当前实现 | 建议职责 |
|---|---|---|
| 管理员 / 员工身份 | 一个实例的管理员 Token；员工用独立 MoneyKey | MoneySwitch 管组织权限；后续对接 OIDC / SSO，避免自行实现账号恢复体系 |
| 钱包 | 实例共用的加密本地钱包 | 内置钱包保留为自建选项；通过签名适配器接入专业钱包服务 |
| x402 | 请求报价、策略检查、授权签名、结算与收据 | MoneySwitch 保留预算、允许域名、审批、幂等与账本控制 |

创建 MoneyKey 是发放受限付款权限，不是创建一个独立充值账户。额度不是链上余额。
钱包密码丢失仍是可恢复性问题，不能据此宣称整个系统安全。自动解锁意味着部署环境持有解锁凭据；若攻击者同时拿到它和加密钱包，磁盘加密不能保护资金。

## 官方实现给出的路径

- [Coinbase Agentic Wallet skills](https://github.com/coinbase/agentic-wallet-skills)：awal 支持邮箱验证码登录。其 [x402 支付说明](https://github.com/coinbase/agentic-wallet-skills/blob/main/skills/agentic-wallet/references/x402-pay.md) 当前写明 Base USDC；不能直接声称适配 Monad。它解决 Agent 钱包使用，不自动接管 MoneySwitch 的员工额度。
- [CDP SDK](https://github.com/coinbase/cdp-sdk/blob/main/typescript/packages/cdp-sdk/README.md)：提供 x402 客户端与钱包 signer 适配器，可以放在 MoneySwitch 策略检查后的签名位置。服务端 API 凭据和 wallet secret 不下发给员工或 AI。
- [CDP AgentCore template](https://github.com/coinbase/cdp-agentcore-template)：邮箱/社交登录、嵌入式钱包、可撤销且有期限的委托授权，适合参考用户流程；项目明确是参考实现，不是生产就绪方案。
- [x402 官方仓库](https://github.com/x402-foundation/x402)：规定 HTTP 付款交互，不是注册账号或找回钱包的系统。

## 建议流程

登录团队 → 选择钱包来源 → 校验链与签名兼容性 → 明确授权 MoneySwitch 的付款权限 → 创建有预算和允许域名的 MoneyKey → 测试网付一次并查看收据 → 随时撤销 Key / 钱包委托。

外部钱包只“连接地址”不能让服务无人值守签名。必须有受限委托或服务端签名能力；智能钱包还需要逐项验证签名格式与 facilitator 支持。禁止把直接运行 awal 付款当成已受 MoneySwitch 预算保护。

## 实施顺序

1. 先修复现有本地钱包备份、自动解锁可见性、员工 x402 测试入口和错误指引。
2. 将现有 LocalWalletDriver 后端抽象成地址、签名、可用状态与网络能力接口，保留统一策略执行链。
3. 有 CDP 项目及服务端凭据后，实现一个真实 adapter，在 Base Sepolia 验证登录、委托撤销、预算拦截、超时结算和重启恢复；验收通过再开放主网。
4. 后续再扩展多个钱包提供商，不提前堆多个无法工作的登录按钮。

## 自建恢复要求

创建钱包时由管理员设置并确认密码、下载加密备份；分别离线保存备份和密码。自动解锁凭据由部署管理员管理。恢复必须在隔离实例验证地址一致，再决定资金迁移；新建钱包不自动迁移旧钱包资金。
