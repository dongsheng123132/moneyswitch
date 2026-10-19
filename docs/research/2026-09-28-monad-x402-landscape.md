# Monad x402 方向调研（2026-09-28）

来源：主会话工作流（9 个子代理：5 份调查、3 份方案、1 份挑刺）+ 主会话亲自复核。
标注：✅ 主会话已复核；⚠️ 子代理报告，主会话未复核或无法复核。

## 事实

1. **Monad x402 索引已经有人做了** ✅
   - agent402.tools/monad，页面标题 "The Monad x402 marketplace"。
   - 它自己托管 603 个工具，覆盖 12 条链；开源协议是 AGPL-3.0，其中 `tollbooth/` 和 `facilitator/` 两个子目录是 MIT。
   - 基本是一个人加 AI 在做，2026-06 以来提交 4263 次。
   - 不替卖家托管：卖家要自己准备稳定的 HTTPS 地址。
   - 它自报的数字：Monad 上外部买家 30 天只有 6 笔 ⚠️。
2. **Coinbase Bazaar** ✅
   - `/discovery/search?network=eip155:143` 可以按 Monad 过滤。
   - 子代理全量抓取的结果：Monad 约 859 条、42 个 host，实际约 7 家运营方，agent402 一家占约 70%；测试网 10143 是 0 条 ⚠️。
3. **facilitator** ✅
   - molandak 的 `/supported` 列出了 143 和 10143，scheme 有 exact、upto、batch-settlement。
   - 会不会给任意 payTo 结算 ⚠️ 还没验证，第一笔主网实付就能知道。备选是 Solvador，它也列了 143 ⚠️。
4. **SDK** ✅：MoneySwitch 锁定的 `@x402/evm 2.27.0`，默认资产表里已经有 `eip155:143` 的 USDC（`0x754704Bc…b603`），主网不用自定义 parser。
5. **最简单的卖家**：一个 serverless 函数（Vercel 或 Cloudflare），用 `@x402/hono` 或 `@x402/express`，facilitator 显式填 molandak。
   - 不需要服务器、私钥、MON gas、数据库，但需要一个公网 HTTPS 地址。这一点从代码层面确认过 ✅。
   - 在 Vercel 上端到端跑通还没验证 ⚠️。
6. **MoneySwitch 托管收费站 `/t/:slug`（按代码核对）** ✅
   - 只有 admin 能创建收费站。
   - SSRF 规则只拦本机端口，LAN、loopback、云元数据地址都放行。
   - 转发给上游时会剥掉 payment-signature，只带一个没签名的 `x-moneyswitch-payer`；上游如果公网能直连，就能绕过收费站。
   - 所以现在不能直接开放给别人托管。
   - moneyswitch.dev 是 GitHub Pages，还没有公网服务端实例。
7. **AgentVerse Grid 的 Base 正式站有漏洞** ✅
   - `final/app/api/cells/purchase/route.ts` 写的是 `ON CONFLICT (x,y) DO UPDATE SET owner_address=…`：任何人付 $0.10 就能覆盖任意格子，已售的、保留区的都一样。
   - regen-key 接口也不校验主人。
   - 1061 格的构成：保留区 465、官方 410、真实钱包 3 个共 184 格；最后活动是 2026-02-27。
   - 工作量估算：改造约 11–12 人天，新做约 5–7 人天 ⚠️。
8. **新春算命**：签诗是 LLM 现编的，没有签库，不能复算 ✅。老站的解签接口出现过 60 秒超时 ⚠️（另一个会话 9/25–26 观察到）。
9. **x402Radar**：只覆盖 Base；子代理 9/28 访问时，线上 `/` 和 `/api/stats` 返回 500 ⚠️。
10. **另一个终端（会话「X402 服务提供者生态」）**
    - 并没有一个独立的"百万格子方案"，"百万格子"只是 AgentVerse Grid 的站内标题。
    - 那边的口径是收窄范围、不做平台。
    - 那边的算命方案：`sha256(付款地址|问题|北京日期)` 从观音灵签 100 签里选一签，Kimi 写解读，另开免费 `/verify`，Kimi 失败就不结算。
    - Qwen key 曾经明文出现在会话记录里，需要轮换。

## 对计划书 `docs/plan/x402-service-network.md` 的修正

- §3 算命公式里的 tx hash 用不了：不管走收费站还是原生 x402，都是 handler 执行完才结算，算签的时候还没有 tx hash。改成 `hash(付款地址|问题|北京日期)`。
- §9「不做：自建服务索引」依然成立，因为 agent402 已经占了这个位置。

## 原始报告

各子代理的完整报告在工作流 journal 里：
`C:\Users\ZhuanZ\.claude\projects\C--1mineyswitch\14f11469-01f8-44a0-a18b-39f305d9c878\subagents\workflows\wf_a7d27270-02d\journal.jsonl`
