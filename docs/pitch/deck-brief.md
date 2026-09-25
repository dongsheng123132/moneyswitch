# MoneySwitch 路演 deck 内容稿（9/26 Monad Metropolis 深圳 Hacker House）

受众：黑客松评委、Monad 生态导师、开发者。语言：中文为主，关键口号保留英文。时长：3–5 分钟讲完。
风格：dashi-ppt `theme02` 炫光紫绿风。无配图（不生图）。所有数字必须用下面给的真实值，不得编造。

## 逐页（11 页，每页一个信息角色）

1. **封面**（cover）
   - 主标题：MoneySwitch
   - 副标题：Give your AI an API key for money.
   - 一句话：让 AI 像用 API Key 一样花钱——而不是把钱包交给 AI
   - 小字：USDC · Monad · x402 ｜ Monad Metropolis 2026 · 深圳 ｜ 2026.09.26

2. **问题**（statement / context）
   - 标题：AI 已经能付钱了，但没人敢把钱包交给它
   - 要点：x402 让 Agent 按次付 USDC 已是现实（HTTP 402 → 签名 → 结算）；但今天的 x402 客户端示例普遍是 `PRIVATE_KEY=0x…` 直接塞给程序；一次 Prompt Injection 就能把钱包转空；10 个 Agent、100 个 Agent 的钱怎么管，没有答案。

3. **洞察**（statement）
   - 金句：AI 已经把用户教育好了——不是钱包，是 API Key。
   - 解释：Key → Quota → Used → Remaining → Expire → Revoke → Logs。NewAPI / OpenRouter 把这套管理 token 的方式变成了常识。我们把它搬到真钱上。

4. **方案：MoneyKey**（breakdown）
   - 标题：MoneyKey ≠ 钱，≠ 私钥
   - 三栏：① 钱始终是 USDC，在你的低余额金库里 ② AI 只拿 `mk_live_…`：一段有额度、可撤销的花钱权限 ③ 每一分钱像 token 用量一样可见、可审计

5. **怎么工作**（process）
   - 链路 5 步：Agent 用 MoneyKey 调用 → 卖方返回 HTTP 402 报价 → MoneySwitch 策略引擎在**签名之前**检查额度/白名单/审批 → 本地签 USDC 授权，facilitator 在 Monad 结算 → 返回内容，用量 +$0.01
   - 小字：底层全用现成的：x402 官方 SDK · Monad · Circle USDC。我们不发币、不造协议。

6. **兼容 OpenAI / NewAPI**（statement 或 comparison）
   - 标题：MoneyKey 直接当 OpenAI API Key 用
   - 左（今天）：`Base URL = api.openai.com` / `API Key = sk-…` / 按 token 扣虚拟额度
   - 右（MoneySwitch）：`Base URL = 127.0.0.1:4020/v1` / `API Key = mk_live_…` / 每次调用在 Monad 上真实结算 USDC
   - 结论：Cherry Studio、Open WebUI、openai SDK、Claude Code（MCP）零改造接入；NewAPI 可把它当上游渠道。

7. **护栏**（breakdown，6 项）
   - 单笔上限（超出在签名前拒绝）· 日/总预算（并发下原子预留）· 服务白名单 · 人工审批阈值 · 一键撤销立即生效 · 防 SSRF/防重定向劫持付款
   - 一句话：Prompt Injection 让它转 $500？单笔上限 $0.20，签名都不会发生。

8. **真实数据**（metrics，全部是 2026-09-25 在 Monad 测试网实测）
   - 10 笔真实 x402 付款（已结算，0 笔 mock），全部链上可查（Monad 测试网 eip155:10143）
   - 0 MON：Agent 金库不需要 gas，facilitator 代付
   - $0.000126 vs $0.01：上游 LLM 推理成本 vs 每次收费 —— AI 服务用 USDC 按次收钱成立
   - 65 个自动化测试（45 单元 + 20 端到端）全绿
   - 首笔 tx：0x1c83a45d…4d4d（区块 65595248）

9. **现场演示**（process / actions，按时间轴）
   - 0:00 Dashboard：给 Claude 开一把 $0.50/天 的 MoneyKey
   - 0:20 Claude Code 自己买一份付费报告 → 付 $0.01，Usage 实时出现链上 tx
   - 0:40 Playground：MoneyKey 当 OpenAI Key 对话，每条消息 $0.01
   - 0:55 恶意请求 $5 → PER_REQUEST_LIMIT_EXCEEDED
   - 1:10 超审批线 → Dashboard 一键批准
   - 1:25 Revoke → KEY_REVOKED

10. **路线图**（trend / actions）
   - v0.1 ✅ 今天：MoneyKey + 策略 + x402 + MCP + Dashboard（单机自托管）
   - v0.2 ✅ 今天：OpenAI/NewAPI 兼容网关 + 渠道 + Playground
   - v0.3：按 token 计价（x402 upto）· MetaMask / OKX 钱包驱动 · 一键给本机 Claude/Codex/OpenClaw 配 Key
   - v0.4：企业版多用户 / 部门额度 / 审批流 / 审计 —— 一个 USDC 资金池，分发给每个员工的每个 Agent
   - 开源：接入层（MCP、适配器、卖方示例）Apache-2.0；服务端 AGPL-3.0

11. **结尾**（closing）
   - 大字：Your AI gets pocket money. You keep the bank account.
   - 小字：MoneySwitch · API keys for money · USDC · Monad · x402
