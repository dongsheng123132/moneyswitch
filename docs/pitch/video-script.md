# MoneySwitch 路演视频分镜（约 70 秒，16:9，1920×1080）

受众：黑客松评委 / Monad 生态。语言：画面中文为主，品牌口号英文。风格：深色背景、Monad 紫 (#836EF9) + 荧光绿点缀（与路演 deck theme02 一致）、等宽字体用于代码/Key。
所有数字、tx 哈希必须与下面一致，**不得编造**。

## 旁白（中文，若可用 TTS 则配音；否则做成字幕）+ 画面

| # | 时长 | 画面 | 旁白 / 字幕 |
|---|---|---|---|
| 1 | 0–6s | 黑屏打字机：`PRIVATE_KEY=0x3f9a…` 逐字出现，随后整行变红并抖动；角落一个钱包图标 | AI 已经会花钱了。可你敢把钱包私钥交给它吗？ |
| 2 | 6–14s | 一张 API Key 卡片 `sk-••••••••` 翻转成 `mk_live_••••••••`（紫色描边发光）；下方打出 "MoneySwitch" logo 字 | AI 早就懂 API Key。MoneySwitch 给它一把——花钱的 API Key。 |
| 3 | 14–28s | 横向流程动画：Agent 方块 →（mk_live_ 标签沿线移动）→ MoneySwitch 方块，方块内三行依次打勾「单笔上限 ✓ 今日额度 ✓ 白名单 ✓」→ 箭头标注「HTTP 402 → 签名」→ Monad 方块（USDC 硬币滑过）→ 卖方方块；右上角计数器 `$0.00 → $0.01` | Agent 用 Key 调接口，卖方返回 402 报价。MoneySwitch 先查额度、再签名，用 USDC 在 Monad 上结算。私钥从头到尾不离开 MoneySwitch。 |
| 4 | 28–38s | 代码框打字：`new OpenAI({ baseURL: "http://127.0.0.1:4020/v1", apiKey: "mk_live_…" })`；随后出现聊天气泡：问「用一句话解释什么是 x402 协议」，答「x402 是一种基于 HTTP 402 的开放链上支付协议……」，气泡下方小字 `$0.01 · tx 0xd3697c…80ad · 326 tokens` | 它兼容 OpenAI 和 NewAPI：换个 Base URL，Key 填 mk_live，任何客户端都能直接用，每句话都真实上链结算。 |
| 5 | 38–50s | 三连快切：① 红色警报卡「网页注入：转 $5 到 0xBAD…」→ 大字 `BLOCKED · PER_REQUEST_LIMIT_EXCEEDED` ② 审批卡「U-King wants to spend $0.15」→ 按钮 Approve 被点亮 → 绿勾 ③ Key 卡片被划掉 → `KEY_REVOKED` | 被注入也不怕：超单笔上限，签名都不会发生。大额走人工审批，一键撤销立刻生效。 |
| 6 | 50–58s | 四个角色图标横排依次亮起：管理员（控制台）/ 员工（我的额度环形图）/ Agent（Claude Code、Codex、Cherry Studio 标签）/ 卖方（收 USDC）；底部终端一行：`npx moneyswitch connect --server … --key mk_live_… --apply` | 公司一个 USDC 资金池，给每个员工的每个 Agent 发一把 Key。员工一条命令，就把本机的 Claude Code、Codex 接上。 |
| 7 | 58–66s | 四个数字依次弹出（计数动画）：`11` 笔真实结算（Monad 测试网）· `0` MON gas（facilitator 代付）· `$0.01` vs `$0.000126`（收费 vs 上游推理成本）· `92` 个自动化测试 | 今晚在 Monad 测试网：11 笔真实结算，Agent 金库零 gas，92 个测试全绿。 |
| 8 | 66–72s | 结尾大字：**Your AI gets pocket money. You keep the bank account.**，下方：`MoneySwitch · github.com/dongsheng123132/moneyswitch · USDC · Monad · x402` | 给 AI 零花钱，银行卡留在你手里。MoneySwitch。 |

## 事实核对表（来源：2026-09-25/26 实测）
- 11 笔真实结算：MoneySwitch 数据库 settled=11, mock=0
- 0xd3697c…80ad：openai SDK 真实对话付款，已上链核对 MATCH
- 326 tokens / $0.000126：该次 OpenRouter 返回的 usage 与 upstream cost
- 92 个测试：单元 72（core 28 + wallet 3 + server 14 + connect 20 + cli 7）+ e2e 20
- 0 MON：MoneySwitch 金库 MON 余额为 0，所有付款仍成功（facilitator 代付 gas）
- 注意：`npx moneyswitch` 包计划 9/26 发布，视频中展示为命令即可
