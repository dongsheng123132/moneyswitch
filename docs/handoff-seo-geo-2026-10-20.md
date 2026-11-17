# 交接：MoneySwitch SEO / GEO 内容推广（2026-10-20）

新会话从这里接手。目标：**让搜"x402 买方付款""AI agent 花钱额度"的人，和在 AI 搜索里问这类问题的人，都能落到 moneyswitch.dev。**

## 一、上一轮已交付（不要重复做）

| 事项 | 状态 | 证据 |
| --- | --- | --- |
| 仓库描述 / 主页 / topics 修正 | 已生效 | description 含 Base/Monad/Solana devnet；homepage = moneyswitch.dev；topics 删 mcp、加 base/http-402/solana/wallet |
| awesome-agentic-commerce 收录 | PR OPEN | https://github.com/Merit-Systems/awesome-agentic-commerce/pull/817 |
| x402-dev 收录 | PR OPEN | https://github.com/michielpost/x402-dev/pull/202 |
| awesome-x402 收录 | PR OPEN（更早） | https://github.com/xpaysh/awesome-x402/pull/1837 |
| gold-402（Spending Controls） | PR OPEN，自动检查红 | https://github.com/Haustorium12/gold-402/pull/370 |
| npm `moneyswitch@0.5.0` | **刻意保持原样** | 源码已在 `7ae97fe`（2026-10-03 atomic trim）删除；SPEC §8 把 CLI/MCP 列为"现在不做"。改描述必须发版且本机未登录 npm，决定不动 |
| 推广台账 | 已写 | `output/x402-promotion-2026-10-19.md` |

`C:\1mineyswitch\.forks\` 下留着两个 fork 的本地克隆，可删。

## 二、本轮要做：SEO + GEO 文章

用户原话：「多写点 seo geo 的文章吧」。

### 2.1 发布管线（先读，别猜）

- 文章源文件：`docs/blog/<slug>.md` 和 `<slug>.zh.md`（英文 + 中文各一份）
- 发布脚本：`scripts/build-blog.mjs`，它把 markdown 渲染到 `site/blog/<slug>/` 和 `site/blog/zh/<slug>/`
- **新文章必须手动加进 `build-blog.mjs` 的 `ARTICLES` 数组**（slug、date、shareImage、双语 description），否则构建产物里没有它
- 部署：`.github/workflows/pages.yml`，push 到 main 且改动 `site/**` 时触发 GitHub Pages
- **注意**：CI 和 Pages 都不跑 `build-blog.mjs`。站点是构建产物进 git、再整体发布。改完 markdown 必须本地跑 `node scripts/build-blog.mjs` 并提交 `site/` 产物，否则线上不会变

### 2.2 现有页面已有的 SEO 基础

`pageShell()` 已生成：`<link rel=canonical>`、`hreflang`、`og:*`、`twitter:card`、语言切换。**没有** 的东西：

- 没有 `sitemap.xml`
- 没有 `llms.txt`
- 博客文章没有 `BlogPosting` JSON-LD（`site/index.html` 有 1 处 ld+json，文章模板里是 0）
- `site/robots.txt` 只有 `User-Agent: * / Allow: /`，没有 Sitemap 行

这四项是 GEO（生成式引擎优化）的骨架，优先级高于堆文章数量。

### 2.3 建议的文章选题（按搜索意图，不按产品自述）

写之前先确认每篇对应一个**真实搜索问句**，文章标题要能直接回答它。

**买方视角（核心，MoneySwitch 唯一有资格写的）**
1. `how-to-give-an-ai-agent-a-spending-budget` — 给 agent 定额度，别给私钥。目标问句："How do I limit how much my AI agent can spend?"
2. `x402-client-side-spending-controls` — x402 买方支出控制的实现方式对比（阈值/白名单/审批）。目标问句："How do I control x402 payments from an agent?"
3. `human-approval-for-agent-payments` — 超过审批线找人批。目标问句："How do I require approval before my agent pays?"
4. `self-hosted-wallet-vs-api-key` — 自托管钱包 vs 把交易所 API key 塞给 agent。目标问句："Is it safe to give my AI agent a wallet?"

**协议/技术视角（拿长尾 + 被 AI 引用）**
5. `x402-exact-scheme-eip3009-explained` — 讲清楚 `exact` scheme 与 EIP-3009 `transferWithAuthorization`，为什么不是 Permit2。目标问句："How does x402 exact scheme work?"
6. `x402-on-base-vs-monad-vs-solana` — CAIP-2 网络标识与实际差异。目标问句："Which networks does x402 support?"
7. `what-happens-when-an-x402-payment-fails` — `payment_unknown` 不能自动重试（诚实计费）。目标问句："What if an x402 payment fails halfway?"

**已有资产可复用**：`docs/blog/qwen-agent-pays-nansen.md` 里已经有 5 笔真实主网付款和 tx 链接，是所有文章中证据最强的一篇。新文章可以引用它，但**不要重复写同一件事**。

### 2.4 GEO 的具体做法（跟普通 SEO 不一样的地方）

AI 搜索抓的是**可被直接摘抄的答案块**，不是关键词密度。每篇文章应包含：

- 开头 2–3 句直接给出答案（"给 AI agent 定额度的方法是……"），不要铺垫
- 一个 `## Short answer` 或同等结构的小节，便于模型整段引用
- 明确的事实与数字（价格、网络 ID、限额字段名），带来源链接
- 一个 `## FAQ` 小节，问题用真实问句
- 结构化数据：`BlogPosting` + `FAQPage` JSON-LD
- 页面末尾给 `llms.txt` 可索引的纯文本摘要（这是 GEO 的关键，站点目前完全没有）

### 2.5 诚实性红线（违反会毁掉信任，且和 SPEC 冲突）

- MoneySwitch 是**买方**产品。不写"接收付款""收款""托管他人资金"
- 不写"支持所有 x402 服务"。实际能力以 SPEC.md §6 的网络列表为准
- **公开 demo endpoint 只有 Monad testnet**（`/x402-testnet/check`，0.01 test USDC）。涉及真实付款的例子必须注明网络和是否是测试币
- 不写"链上强制限额""托管钱包"。限额在服务端执行，不是智能合约
- 中文文章与英文文章内容要一致，不能中文吹得更大

## 三、开工顺序建议

1. 先补 SEO/GEO 骨架：`sitemap.xml`、`llms.txt`、文章模板加 JSON-LD、robots 加 Sitemap 行。这些是一次性投入，所有文章都受益
2. 再写 2–3 篇，从上面「买方视角」里挑，因为那是 MoneySwitch 真正有独特素材的部分
3. 每篇写完：加进 `ARTICLES` → 跑 `node scripts/build-blog.mjs` → 检查 `site/blog/` 产物 → 本地看渲染 → 提交
4. 中英文同批交付，不要只做英文

## 四、验证命令

```powershell
# 构建博客（改完 markdown 必须跑）
node scripts/build-blog.mjs

# 本地看站点
npx serve site

# 确认文章进了构建清单
node -e "const s=require('fs').readFileSync('scripts/build-blog.mjs','utf8'); console.log(s.match(/slug: '[^']+'/g))"
```

## 五、未决 / 需要用户拍板

- `sitemap.xml` 和 `llms.txt` 是否直接生成进 `site/`（静态文件）还是加进 `build-blog.mjs`（自动生成）。**建议后者**，否则每加一篇文章要手动改两个地方
- 文章是否要配封面图。现有文章用了 `site/assets/img/<batch>/cover-en.webp` 这类路径；没有封面的话 `build-blog.mjs` 会退化到站点默认 `og.png`，可以接受
- 是否同步到外部平台（Dev.to #x402、掘金、V2EX）。这是分发问题，不是写作问题，建议文章全部落地后再决定

## 六、环境提醒

- 分类器 `group/smart-split-2kimi` 会间歇性超时，卡住 Bash/WebFetch；**只读工具（Read/Grep/Glob）不受影响**，先做能做的，稍后重试
- 需要公开写入（新 fork、新 PR、改别人的仓库）时，分类器要求用户**点名目标**，"好的"这种泛批复不算
- 用户终端是 PowerShell，给命令要用 PowerShell 语法和绝对路径
