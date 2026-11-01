# MoneySwitch 提交动态说明

> 生成时间：2026-10-04 · 数据来源：`git log --all`（2026-09-26 ～ 2026-10-04 00:06）
> 用途：Monad Metropolis 项目更新 / 提交材料附件的动态留档

## 一、一句话总览

**上线 → 加固 → 收窄**：9/26–9/27 产品可运行并完成主网真实支付验证；9/28–10/2 补稳定性和支付可靠性；10/3–10/4 执行 v0.7 精简（删网关、删推送、删桌面启动器），并对钱包做了一轮完整的安全审查整改。

## 二、主题块明细（按内容分组，含提交动态）

### A. 产品上线 + Monad 主网验证（9/26–9/27 · main）

| Hash | 时间 | 提交动态 |
|---|---|---|
| ab52d4d | 09-26 00:22 | MoneySwitch v0.3：API keys for money（x402 + USDC + Monad） |
| 06ec32f | 09-26 03:03 | UX 打磨：首次运行向导、i18n、可用的一键连接命令 |
| d73e8dd | 09-26 09:34 | v0.4：子 key（多级授权）+ 本地桌面控制台 |
| c9510b7 | 09-26 09:43 | 官网落地页（GitHub Pages），带真实 Monad 测试网证明 |
| 95f927c | 09-26 11:46 | v0.5：收费站——让任意 API 向 AI 收 USDC |
| 5fc99ce | 09-26 13:07 | v0.5.1：`npx moneyswitch demo/server`、链上对账 |
| d3e0dd6 | 09-27 14:08 | pitch deck v2（16 页）+ 提交草稿 |
| 4bc9e15 | 09-27 20:32 | **Monad 主网模式 + 第一笔真实主网 x402 支付（Nansen）** |
| fc56f4b | 09-27 22:30 | Qwen 3.8 Max 研究 Agent（经 MoneySwitch 买 Nansen 数据） |
| 922dd20 | 09-27 22:46 | 博客《Qwen 3.8 Max 自己花钱买了 Nansen 数据》（中英双语） |
| 1e0d81d | 09-27 23:14 | moneyswitch.dev 上线，博客接入 |

**意义**：完成"可运行产品 + 真实链上证据"的最小闭环；主网第一笔支付和 Qwen 自主购买是比赛最有说服力的两张牌。

### B. 稳定性与网络适配（9/28–9/29 · main）

| Hash | 时间 | 提交动态 |
|---|---|---|
| 33dbf51 | 09-28 21:19 | 出站 HTTP(S) 代理自动跟随（Clash/v2rayN），server + CLI |
| f82e908 | 09-29 00:55 | 修复 Windows 退出崩溃（beforeExit 关闭代理调度器） |

**意义**：国内环境可开箱即用，不再要求用户手改代理配置。

### C. 支付可靠性：钱付了、结果没拿到（10/2 · wp/timeout 集成）

| Hash | 时间 | 提交动态 |
|---|---|---|
| 850b49a / 8597d07 | 10-02 09:48 | changelog + MCP `paid_fetch` 报 `payment_unknown` / `UPSTREAM_BODY_INCOMPLETE` |
| 38af67a | 10-02 09:48 | reconcile 通过分块 AuthorizationUsed 日志找回已用授权的 tx hash |
| 06f515f | 10-02 09:48 | 付费截止时间真正约束请求；未发出的支付不算"可能已扣款"；success:false 保持 unknown |
| 793c861 | 10-02 09:48 | 调用方截止时间下的 undici 空闲定时器隔离 |
| 83da8d1 | 10-02 09:48 | reconcile 不可自我撤销、可回填缺失 tx hash、保留已上报 hash |
| ed42a01 | 10-02 10:52 | 同一时间只跑一次 reconcile；启动/每 15 分钟/按需回填 |
| f557c9a | 10-02 10:52 | MCP、qwen-agent 等待 /v1/fetch 裁决，坏掉的交换报"结果未知" |
| 86d748e | 10-02 10:52 | Playground 不再把可能已扣款的调用说成"免费/没扣" |
| 6152204 | 10-02 10:52 | changelog：paid-but-no-delivery 修复评审轮 |

**意义**：AI 付款最怕"钱付了没结果"，这组改动让每一笔结果不明的支付都被明确标记、事后对账兜底，AI 不会盲目重试。

### D. 审批推送 + Agent Skill（10/2 · wp/notify + wp/skill 集成）

| Hash | 时间 | 提交动态 |
|---|---|---|
| c1fe988 / 06e645d / 9920d4f / d50f0f6 | 10-02 09:53 | 审批需人工时推送飞书/企业微信/Telegram/webhook（含 outbox 表与设置） |
| fec2bee / 6fea316 | 10-02 10:28 | 按渠道隔离投递、发送时校验过期、洪水控制；webhook URL 主机也脱敏 |
| a73ee60 / 590665b / 52d5861 / 66d8c06 | 10-02 10:13 | `@moneyswitch/skill`：GET /skill.md、GET /v1/approvals/:id、POST /v1/keys/:id/rotate；skill 成为连接 agent 的首选方式 |
| 3dda1fe / abed4e8 / 3852a02 / bc76f74 / c30edaf | 10-02 11:14 | 每个 agent 的 key 只存到它自己会加载的位置；secret 被重置后拒绝旧认证请求；等待卖家时重置 secret 的 e2e |
| 9458e72 / 008838d / 9e83613 | 10-02 13:37–13:39 | 三条 wp/* 集成进主线（tag: archive/tollbooth-v0.5） |

**意义**：审批从"人去后台翻"变成"直接推送到人"；skill 让"把 key 交给 AI"变成粘贴一段说明即可。

### E. 买方基础设施 + 自托管部署（10/2–10/3 凌晨 · v0.6-wallet 早期）

| Hash | 时间 | 提交动态 |
|---|---|---|
| 919ccae | 10-02 14:36 | 完成买方基础设施：多链支付 + 自托管部署 |
| 9d9ae6d | 10-02 14:57 | 记录真实自托管部署 + 隔离包验收 |
| ec7b89a | 10-02 16:58 | 简化 agent 设置反馈；解释沙箱 TLS 失败 |
| bb40ad2 | 10-03 00:28 | 钱包导入 + 加密备份（共享设置） |
| 23e45f8 | 10-03 08:20 | Windows 桌面启动器（本地钱包管理） |
| a60bb0a | 10-03 09:29 | 独立主网 x402 收款服务（0.1 USDC） |
| 86540af | 10-03 10:41 | codex/claude-handoff：让 x402 测试可及、自托管钱包恢复说明 |

**意义**：把"自己能跑起来"落实到位（多链、自托管、桌面启动器），并补了主网收款侧验证。

### F. 钱包安全审查整改（10/3 中午–晚 · v0.6-wallet，M1–M7 + LATENT）

| Hash | 时间 | 提交动态 |
|---|---|---|
| 319b777 / a7aab24 / 368758d | 10-03 12:22–12:23 | 钱包生命周期表、恢复短语、自动解锁密钥、安全重加密、replace、server 生命周期 API |
| c2d1b82 | 10-03 12:38 | demo-seller 移除主网 0.1 USDC 收款端，保留测试网 |
| 378d8d5 | 10-03 12:57 | dashboard：免密码钱包设置、恢复短语流程、健康卡片、danger zone |
| eed3d23 | 10-03 13:08 | docs：钱包模型（默认自动解锁、恢复短语、replace）、部署指南、changelog |
| d9295c5 / 5809fd1 | 10-03 13:25 | 退出登录时内存丢弃恢复短语；钱包路由进脱敏套件 |
| b577c59 | 10-03 15:46 | core：清扫死进程遗留的支付预留（M4a） |
| 916f443 | 10-03 15:49 | 按安全审查加固钱包生命周期（M1 M2 M3 M4b M5 m6 m7 LATENT） |
| 7260349 | 10-03 16:18 | 显示解锁失败原因；导入与未保护 secret 警告；备份完成前隐藏地址 |
| 4a8c633 / 5a455dd / a542eb4 | 10-03 16:37 | demo-seller 收款测试并入 pnpm test；migration 0007 增量可回滚；安全审查后的钱包模型文档 |
| e11a000 | 10-03 17:01 | 测试：chat 网关也持有签名 lease |
| aa63aec / 6a5c957 / 6ace9a4 / 5131693 | 10-03 17:41 | 删除 getSigner()，leaseSigner() 唯一；密码丢失的锁定钱包总能替换（e2e + 文档） |
| f033eaa | 10-03 18:30 | 失败的 swap 不搁浅新 secret；移走的 secret 会回来 |
| ce179d7 / 445ebb8 / d680069 | 10-03 18:45–19:17 | retired/ 无密码打不开活 key（#1）；ACL 按 SID 回读、protector 不阻塞事件循环（#3 #4）；replace 不被饿死（#2） |
| fc5d90b | 10-03 19:24 | 只付 EIP-3009；Permit2 offer 拒绝为 UNSUPPORTED_PAYMENT（#7） |
| 38b8c9f / 6daa3a1 / fb9f8e2 | 10-03 19:32–19:47 | 备份以 /data 属主运行并校验（#5）；诚实恢复措辞、retired-copies 标记；第三轮审查文档 |

**意义**：钱包是"给 AI 管钱"产品的心脏。这轮把签名获取、替换、备份、恢复四条路径全部按审查结论加固，并保证"换钱包前一定能拿回旧钱包里的钱"。

### G. v0.7 精简：删到只剩三件事（10/3 晚 – 10/4 · v0.6-wallet）

| Hash | 时间 | 提交动态 |
|---|---|---|
| 2af746f | 10-03 22:04 | 删除 OpenAI 兼容网关 + 模型渠道 |
| 7ae97fe | 10-03 22:05 | 删除离线 demo、MCP server、apps/cli 包 |
| 173b2e5 | 10-03 22:05 | Dashboard 原子修剪（channels/chat/connect/demo） |
| 10f19b5 / d29f3af / 2849382 | 10-03 22:07–22:23 | shell 脚本固定 LF；被删功能返回 404 的测试；docs/README/官网收窄 |
| b1b7a94 / f92ad94 / 4881798 | 10-03 22:30–22:33 | server e2e 不持 key；deploy-smoke 验证路由已删；清掉 demo/CLI 最后引用 |
| 4de2033 / c258503 / 0986628 | 10-03 22:43–22:56 | notify 计时测试修正；Dashboard 清理遗留 CSS；fetch-flow e2e 去 MCP 化 |
| 9727c2d | 10-03 23:13 | SPEC 只认 v0.7，归档 SPEC v0.1–v0.6 |
| 591b1a0 / 7529e04 / d11ece1 | 10-03 23:18–23:25 | 删 Windows 桌面启动器、卖家残留（收费站注释/facilitatorUrl/earnings.css）、推送通知模块 |
| 51f1472 | 10-04 00:06 | 钱包面只留 status / create / backup 确认 / replace（SPEC §1 §5） |

**意义**：v0.7 拍板"只做三件事（钱包 / Key / 付款）"，验收标准是"新用户 10 分钟内让 AI 付成第一笔"。这组提交把不在这条路上的东西全部删干净，产品面收窄到可被一个新人十分钟理解。

## 三、当前状态与下一步

- **分支**：v0.6-wallet 尚未合入 main（最新提交 51f1472，10/4 00:06）；main 停在 10/2 的 gateway SSE 修复。
- **待清理**：SPEC-v0.7 §6 要求清理 9/27 那批 `cloud/*` 分支（editable-keys、mcp-discover-approvals 等），合前需确认无独有提交——MCP server 与 CLI 已删，相关分支价值需重新评估。
- **待验收**：v0.7 收尾 = 干净机器 `docker compose up` → 10 分钟内完成"建钱包→充值→发 key→AI 付成第一笔"，并计时留档。
- **比赛**：Monad Metropolis 提交截止 10/14 11:59（GMT+8）；平台项目更新稿已起草（英文/中文两版），本文件可作为提交动态附件。

## 附：分支关系速记

```
main (9/26–10/2 产品/稳定/SSE)
  └─ codex/claude-handoff（集成 wp/timeout + wp/notify + wp/skill）
       └─ v0.6-wallet（10/2–10/4：钱包生命周期 → 安全加固 → v0.7 精简）★当前工作分支
cloud/*、worktree-agent-*：9/27 云端任务遗留，待清理
```
