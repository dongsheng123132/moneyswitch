# Monad Metropolis 结果公布：MoneySwitch 入选 Alibaba Cloud 的 Qwen 3.8 Max 专项

![MoneySwitch：给 AI Bot 的可编程 Web3 云钱包。Monad Metropolis 提交用图。](https://moneyswitch.dev/assets/img/metropolis-2026-11/cover-zh.webp)

*2026 年 11 月，Monad 年度旗舰黑客松 Metropolis 公布结果。MoneySwitch 出现在 Alibaba Cloud「最佳 Qwen 3.8 Max 技术应用」专项的名单里。*

## 发生了什么

本届 Metropolis 从 9 月 1 日跑到 10 月中旬，885 支团队、1,256 位 Builder，提交来自 76 个国家和地区。四大赛道之外，生态伙伴各自设了专项 Bounty，Alibaba Cloud 那条叫「最佳 Qwen 3.8 Max 技术应用」，名单上是三个项目：Sandworm、Red Sentinel，和我们 MoneySwitch（提交署名 `@bitpus888`）。

说清楚它的分量：这不是四大赛道的名次奖（那是每个赛道三个 $10,000），是赞助方在自己关心的技术栈上挑出来的项目。被选中的不是「又一个 demo」，而是这条链路：一个大模型、一批按次付费的 API、一个由人设好边界的钱包，三者能不能真的串起来。

## 我们交了什么

两件东西拼在一起。

**一个自己托管的云钱包。** MoneySwitch 不把私钥交给 Agent，而是发一把 **MoneyKey**：一把「能花钱的 API Key」。它有总额度、单次上限、允许访问的域名白名单、人工审批线和一键吊销。Agent 调 `POST /v1/fetch`，钱包**先检查策略再签名**，然后从只放小钱的本地钱包里用 USDC 付掉卖方的 x402 账单。Agent 自始至终碰不到私钥。

**一个真的会花钱的 Agent。** Qwen 3.8 Max 拿到一把 0.09 美元预算的 key 和一张价目表，自己决定买什么：先在 Monad 主网上用三次 0.01 美元的查询把问题缩小，最后花 0.05 美元确认聪明钱到底有没有进场。五笔真实的 USDC 付款，每一笔都能在链上查到。完整实验记录在[上一篇文章](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/zh/)里。

## 为什么这条路值得被选中

x402 已经把「付钱」这一步变简单了：不用注册、不用 API key，一个 `402 Payment Required`、一次 EIP-3009 授权，就把一分钱付出去。难的是另一半，**授权**：这个 Agent 能花多少、能花在哪、什么时候该停下来等人。

我们的四条边界，都不是「更聪明的模型」能替代的：

- **策略在签名之前执行。** 额度、白名单、审批线都是签名前的检查，不是花完之后的对账。
- **人保留否决权。** 达到审批线的付款直接挂起，等人在 Dashboard 上点批准。
- **每把 key 各记一本账。** 谁花的、花了多少、对应哪笔链上交易，一次看清。
- **失败时不猜。** 卖方返回 422 不结算时，签过名的授权会被冻结而不是立刻退回；等它过期，去问 USDC 合约确认没被用过，才恢复额度。

Qwen 3.8 Max 证明了另一半：给它预算和价目表，它能像分析师一样花钱，而不是像死循环一样重复重试。

## Monad 上实际跑了什么

| 环节 | 实际情况 |
|---|---|
| 链 | Monad 主网 USDC x402（`eip155:143`），Molandak facilitator 结算 |
| 付款 | 5 笔真实 USDC，合计 $0.09，全部可在 monadvision.com 查到 |
| 测试网演示 | 两把独立 MoneyKey、直接付款、人工审批后付款、账单、撤销 key，2 分 02 秒录屏 |

这次提交用的封面图，就是上面那张：**部署在你的云上，让 Bot 按你的规则花钱。** 这句话到今天仍然是我们唯一的产品定义。

## 接下来

获奖不是终点，是一张「这条路有人认」的确认书。接下来三件事：

1. **试用。** 跟着[自托管与测试网指南](https://moneyswitch.dev/pilot/zh/)部署自己的实例，半小时能跑完第一笔测试网付款。
2. **提 Issue / PR。** 文档、接入说明、小范围修复都欢迎；[第一次提 PR](https://moneyswitch.dev/contribute/zh/)的步骤写好了。
3. **真实场景。** 如果你的 Agent 在读付费数据、调付费 API，把场景写给我们，我们按场景改产品，而不是按想象改。

感谢 Monad 和 Alibaba Cloud 的评审，也感谢同赛道做出好项目的 Sandworm 和 Red Sentinel。

**试一试：** [自托管与测试网指南](https://moneyswitch.dev/pilot/zh/) · [源代码](https://github.com/dongsheng123132/moneyswitch) · [Qwen 实验记录](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/zh/) · [产品演示](https://moneyswitch.dev/videos/technical-demo/)
