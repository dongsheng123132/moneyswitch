# x402 服务网络：人人能付、能限额、也能收（规划稿）

> 状态：规划稿，2026-09-27。未实现。调研事实标注了「已验」/「未验」。
> 与 SPEC 冲突时以 SPEC 为准；本文件批准后再拆成 SPEC-v0.6。

## 0. 一句话

MoneySwitch 让每个人的 AI 工具**能付款（带限额）**，也让每个人的电脑/服务器**能收款**。
把大家的收款服务串起来，就是一张基于 x402 的服务网络：
我卖算命，你卖作图，他卖链上数据，AI 拿一把限额子 key 按次付款、串起来用。

## 1. 现状：已经有的 vs 缺的

| 能力 | 状态 |
|---|---|
| AI 付款 + 限额 | ✅ MoneyKey、子 key（v0.4） |
| 任何人收款 | ✅ 收费站（v0.5）：`npx moneyswitch sell --upstream http://127.0.0.1:8080 --pay-to 0x… --price 0.01`，原服务一行不改 |
| 卖家示例（抄了就能改） | ❌ 本规划 §3 |
| 服务合集（让人找到、玩起来） | ❌ 本规划 §4 |
| AI 自己发现服务 | ❌ 本规划 §5 |

## 2. 合集的定位：收录别人的，不是自己造轮子

**合集收录所有 x402 卖家，包括别人的**（Nansen、penny402 塔罗、各种作图/LLM 服务），不只是用 MoneySwitch 收款的。原因：

1. **我们是钱包，不是商店。** MoneySwitch 的价值在买家这一侧：卖家越多，MoneyKey 越有用。收录别人的服务 = 给我们的用户增加能买的东西。
2. **发现用现成的。** Coinbase Bazaar 已收录约 1.7 万个 x402 服务，且接口公开免费；我们直接接它，不自建索引。
3. **我们补的是空位**：
   - 现有最大合集 [xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402) 把 SDK、文章、卖家混在一起，**Monad 上的卖家没人整理**；
   - 每个条目多一行「用 MoneySwitch 一条命令调用」（带限额），这是别的合集没有的；
   - 「我也想卖」的入口指向 `moneyswitch sell`，给我们带来卖家侧用户。

所以流量是双向的：合集把**买家**带给卖家，把**卖家**带到 `moneyswitch sell`。

## 3. 卖家示例（moneyswitch 仓库 `examples/sellers/`，每个 30–80 行）

每个示例都是普通 HTTP 服务，前面挂 `moneyswitch sell`；先测试网跑通、留 tx 证据。

| 示例 | 价格 | 做什么 | 赞助商 |
|---|---|---|---|
| `onchain-message` | 0.01 | 把「我爱张三」写上 Monad（calldata/event），返回永久页 `/p/{txhash}` + 浏览器链接。服务挂了浏览器链接也还在，「永久」由链保证 | Monad |
| `fortune` | 0.01 | 哈希算命：`keccak(付款地址‖tx hash‖日期) mod 100` 选签（传统 100 签），可复算可验证；Kimi 写白话解读 | Kimi |
| `image` | 0.05 | Qwen / Wan 作图（可以把签文画成签图） | Qwen |

**Demo 主线**（四个赞助商全用上）：
AI 拿一把**子 key**（限额 $0.10）→ 付 **Nansen** 买链上数据 → 付**我的**算命服务（Kimi）→ 付**别人的**作图服务（Qwen）→ 结果写上 Monad、给永久 URL。每一步都是 x402，每一步都受限额约束。

## 4. 合集仓库 `awesome-x402-services`（独立仓库，推荐）

- `README.md`：按类别分（作图 / LLM / 数据与预言机 / 链上写入 / 好玩的），Monad 卖家置顶。
- `services.json`：机器可读，AI 也能直接读。每条格式：
  ```json
  { "name": "", "url": "", "method": "POST", "price_usdc": "0.01",
    "networks": ["eip155:143"], "category": "fun", "desc": "",
    "try": "moneyswitch fetch <url> --max 0.02", "verified_at": "2026-09-27" }
  ```
- 加入方式：提 PR 改 `services.json`；CI 自动请求一次，确认返回 402 且价格与声明一致，再合并。
- 种子条目（调研所得，入库前逐个复验）：Nansen（Monad，已验 402）、penny402.fun/tarot（已验 402）、glim.sh（声明支持 Monad，未验）、AgentVerse Grid 格子（Base，$0.10）、BookFinder x402、我们的 3 个示例。

**AgentVerse Grid 联动**：Grid 本身就是 x402 卖家 + agent 可搜的目录（`/api/search`）。
合集里的服务可以在 Grid 上买格子挂牌，Grid 反向链接合集：两边互相导流。

## 5. AI 自己发现服务：MCP 加 `discover`

- `discover(query, maxPrice)`：先查合集 `services.json`，再查 Bazaar：
  `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=&network=eip155:143&maxUsdPrice=`
- 返回候选 + 价格 → AI 选一个 → `paid_fetch` 付款，照常受限额约束。
- 这就是「服务网络」的 demo 时刻：AI 自己找到服务、自己付钱、串起来用。

## 6. 赞助商（待另一终端对照比赛规则核实）

| 赞助商 | 是什么 | 我们怎么用 | 核实状态 |
|---|---|---|---|
| Nansen | 官方用 x402 卖 API，支持 Monad，$0.01/$0.05，只认 v2（`PAYMENT-SIGNATURE` 头） | 我们的 MoneyKey 直接买，demo 第一步 | ✅ 主网真付款已结算（tx `0x98297ba4…5e9c`） |
| Mera | Category Labs 的 Monad passkey 账户库，不是 API | 钱包解锁从密码换成 passkey；「One Passkey, Many Keys」对应子 key | 推断，需对照规则 |
| Qwen | 无原生 x402 | 作图示例挂在收费站后面 | — |
| Kimi | 无原生 x402 | 算命解读 | — |

## 7. 基础设施事实

- Monad 官方 facilitator：`https://x402-facilitator.molandak.org`，测试网 `eip155:10143` / 主网 `eip155:143`，exact/upto，v2（已验 `/supported`）。
- USDC：测试网 `0x534b2f3A21130d7a60830c2Df862319e593943A3`，主网 `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`。
- 本仓库已支持主网模式（`MONEYSWITCH_MAINNET_ENABLED=true`），默认测试网。

## 8. 路线图（截止 2026-10-14 11:59 GMT+8，10-02 开放提交；以 docs/pitch/submission.md 为准）

已完成：Nansen 主网真付款 ✅（tx `0x98297ba4…5e9c`，主网钱包 `0xAB094E59e980c45D735F407514bEBdfc8a365C6E` → Nansen 0.01 USDC，
我在链上独立核对过 receipt）。

### 8.1 奖金结构决定优先级（来源 docs/monad-metropolis-guide.md）
- **主赛道 Track 04 前三各 $10k + 总冠军 $25k**，远大于任何单个赏金。Track 04 原文要点是「让 AI 有用，而不被单一平台 capture 价值」
  → **开放的 x402 服务网络（谁都能卖、没有平台抽成、合集收录别人的服务）正是主赛道叙事**，所以 P1/P2 优先。
- 赏金是加分项，贴着主线做，不另开支线：
  | 赏金 | 金额 | 对应交付 |
  |---|---|---|
  | Best use of Nansen | $5k 现金 | 不只是「买数据」：**付款前用 Nansen 查收款方风险**，高风险拦截（策略在签名前执行；风控本身也经 x402 付费） |
  | Qwen 3.8 Max | $5k **额度** | Qwen 驱动的买家 agent：自己 discover、比价、付款（另一终端在写 `apps/qwen-agent/`） |
  | Best Builds Powered by KIMI | $3k **额度**，全赛道 | 算命服务的签文解读用 Kimi（卖家侧；与 Qwen 买家侧分开，两个都能报） |
  | Mera: One Passkey, Many Keys | $2.5k | 要的是 PRF 的**非钱包**用例 → 一把 passkey 的 PRF 作为子 key 体系的根：解锁金库、批准签发子 MoneyKey |
  | Best Mera-Powered UX | $2.5k | 要求「整个账户层用 Mera」；我们的 agent 需要无人值守签名，和 passkey 每次按指纹冲突 → **技术验证后再决定报不报** |
- 暂不追：MetaMask Agent Wallet 插件（标注 Finance 赛道，我们报的是 Track 04，先确认能否跨赛道报）、Agora（要求做 AUSD 跨境/交易 App，偏离主线）。
- 指南里要订正的：项目已不只在测试网（有主网 Nansen 真付款）；「12 笔真实链上交易」未核对，提交前逐条列 tx 再写。

### 8.2 阶段

| 阶段 | 日期 | 交付 | 验收判据 |
|---|---|---|---|
| P0 Mera 技术验证 | 9/28（1 天，第三个会话） | 用 `@category-labs/mera` 跑通 passkey → PRF → 派生对称密钥加解密金库 keystore | 通 → P3 做；不通 → 只报 One Passkey 的设计稿，不报 UX |
| P1 卖家示例 | 9/28–10/1 | `fortune`（哈希选 100 签 + Kimi 解读）、`onchain-message`（「我爱张三」+ 永久 URL）、`image`（通义万相作图），公网可访问 | 无付款 → 402；MoneyKey 付款 → 结果；主网各留 1 笔 tx |
| P2 网络 + 风控 | 10/2–10/6 | 合集仓库 + `services.json` + PR 校验 CI；MCP `discover`（合集 + Bazaar）；Nansen 收款方风控策略；Grid 挂牌 | 一句话：Qwen agent 自己 discover → 风控查 → 付 Nansen / 算命 / 作图，全程在子 key 限额内，每步有 tx |
| P3 Mera | 10/2–10/9 | 按 P0 结果 | passkey 确认后才能解锁 / 签发子 key |
| P4 提交 | 10/10–10/13 | 视频、deck、提交稿（订正上面两处）、README；10/13 提交 | 视频里每笔付款都有浏览器链接 |

分工：主会话负责规划、判据、真伪裁定，P1/P2 派 coder；另一终端负责主网、Nansen、`apps/qwen-agent`、提交稿；
P0 Mera 开第三个会话。同一块代码只让一个会话改。

## 9. 不做

自建服务索引（用 Bazaar）、平台抽成、担保/退款、非 USDC 币种。
