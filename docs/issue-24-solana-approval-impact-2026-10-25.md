# Issue #24 评估：审批页显示 Solana 付款的真实影响

- 评估日期：2026-10-25（Asia/Shanghai）
- 对象：[GitHub issue #24](https://github.com/dongsheng123132/moneyswitch/issues/24)（2026-10-19 由 `Timothymycompc` 提出，label `enhancement`，0 评论）
- 仓库基线：`main` = `fd497a4`（2026-10-23）；`@x402/svm` 2.27.0；Solana 仅 Devnet
- 相关代码：审批 `apps/server/src/routes/admin.ts`、`apps/dashboard/src/pages/ApprovalsPage.tsx`、`packages/core/src/approval.ts`、`packages/x402/src/client.ts`；Solana `packages/x402/src/solana.ts`、`packages/x402/src/networks.ts`

## 1. 结论

**问题成立，但 issue 原文的接法不成立；值得做的是一次小验证——把审批页已经握在手里的“真实影响”说全，并在 Devnet 上补一次真机审批闭环。外部 dry-run 工具（Solana Pulse）只做一次性离线对照，不进入 runtime。**

一句话理由：审批页批准的是 **402 报价**，不是一笔已经构造好的交易；在 MoneySwitch 这条 exact-SVM 路径上，交易由我们自己按固定指令集构造（一笔 USDC `transferChecked` + memo + compute budget），根本没有 drainer 可以藏的地方。

## 2. 现状核查

### 2.1 审批页

- 审批记录只有：`url`、`method`、`body_sha256`、`network`、`asset`、`pay_to`、`amount`、`expires_at`（[0000_init.sql](../packages/db/migrations/0000_init.sql#L42-L56)，`kind` 在 0008 加上）。**没有交易，也没有 fee payer**。
- 审批在 `onBeforePaymentCreation` 里创建，位置在 402 报价选中之后、SDK 构造并签名之前（[client.ts](../packages/x402/src/client.ts#L552-L640)）；需要审批时直接中止，**什么都不签**（[solana.test.ts](../packages/x402/test/solana.test.ts#L83-L85) 断言支付记录为 0）。
- 页面显示：金额、链 + mainnet/testnet、请求 URL、`pay to <6+4 截断地址>`、倒计时、key 的额度上下文（[ApprovalsPage.tsx](../apps/dashboard/src/pages/ApprovalsPage.tsx#L108-L125)）。API 其实已经返回 `asset`（[admin.ts](../apps/server/src/routes/admin.ts#L186-L206)），页面没用；`fee_payer` 没存；没有一句“这笔会做什么”。
- 绑定关系已经很强：`validateApprovalForUse` 校验 key、URL、method、body hash、network、asset、payTo、amount≤（[approval.ts](../packages/core/src/approval.ts#L126-L151)）。“看到的 = 会付的”这条地基已经在了，缺的只是把事实显示全。
- 审批有效期 10 分钟（[approval.ts](../packages/core/src/approval.ts#L8)）。批准后 AI 重发，SDK 才构造交易，并且**每次签名前重新取 blockhash**（`@x402/svm` `createPaymentPayload`）。

### 2.2 Solana Devnet 链路

- 只有显式配置 `MONEYSWITCH_NETWORKS` 才启用；评估当时仅 Devnet，主网未启用（2026-10-25 起主网也可作显式 opt-in，见 `docs/solana.md`）；独立 SLIP-0010 Ed25519 地址，不能用 EVM 私钥（[networks.ts](../packages/x402/src/networks.ts#L99-L107)、[SPEC.md](../SPEC.md#L81)）。
- 付款必须由第三方 fee sponsor 付手续费：`extra.feePayer` 缺失或等于自己就 `UNSUPPORTED_PAYMENT`（[client.ts](../packages/x402/src/client.ts#L561-L569)）。**审批人钱包的 SOL 不会被花掉。**
- `@x402/svm` 2.27.0 的 exact 路径实际只构造四条指令：`SetComputeUnitLimit`、`SetComputeUnitPrice`、`TransferChecked`（USDC，payer→收款方 ATA）、`Memo`（随机 16 字节或卖家给的 memo）。**没有 approve、setAuthority、closeAccount，也没有任意 program。**
- 链上失败（例如收款方 USDC ATA 不存在）→ `readSvmPayment` 返回 `failed` → `reconcilePaymentToFailed` 把额度释放（[reconcile.ts](../packages/core/src/reconcile.ts#L120-L137)）；确认前仍是 `unknown`、额度继续占用。
- **真机证据缺口**：仓库 `docs/solana.md` 明说 `--pay` 路径仍未跑过、`live funded Solana settlement demo is still pending`（[solana.md](solana.md)），`.data/solana-live/` 不存在。目前只有 mock RPC 的 SDK 集成测试和只读 RPC probe。

### 2.3 已有测试边界（本次实跑，全绿）

| 包 | 结果 | 与本题相关的覆盖 |
| --- | --- | --- |
| `@moneyswitch/x402` | 9 文件 / 123 测试通过 | SVM 构造 + 签名 + 先落证据再发送 + 对账；**审批先于签名**；fee payer 规则；大小写敏感 mint |
| `@moneyswitch/core` | 23 文件 / 273 测试通过 | 审批绑定、host 审批、reconcile 失败释放额度 |
| `@moneyswitch/dashboard` | 219 测试通过 | 审批页/审批链接渲染、PIN、host 审批、“页面不解析 URL”约定（[pages.test.ts](../apps/dashboard/test/pages.test.ts#L474-L503)） |
| `@moneyswitch/server`（unit） | 21 文件 / 262 通过、11 跳过 | 审批 API、PIN、network mode、host 审批 |

缺口：没有“审批页影响字段”的测试；没有 Solana 审批页断言；没有“显示内容 = 实际签名内容”的断言；没有真机 Devnet。

## 3. 提议逐条对账

| issue #24 的假设 | 判定 | 依据 |
| --- | --- | --- |
| 审批时存在一笔 Solana 交易，可以 dry-run | **否** | 审批在 `onBeforePaymentCreation` 创建，交易在批准后重发时才构造并签名 |
| 交易可能“转给别人 / 授权 spender / 改权限” | **否（当前路径）** | exact-SVM 指令集固定；`asset` 必须等于该网络 USDC；没有 approve/authority 指令 |
| 失败仍收手续费、审批人受损 | **否** | fee payer 是第三方 sponsor（且被强制 ≠ 自己），失败只有 sponsor 付 fee；额度在链上确认后释放 |
| Devnet 足以验证 | **部分** | Devnet 链路存在，但真机 settle 尚未打过；且测试币无经济风险，drainer 的用户价值≈0 |
| 接入成本 = 一个 HTTP 调用 | **否** | 要把“签名前构造”提前到审批前，或接受审的不是最终那笔；10 分钟审批窗口 vs 分钟级 blockhash 生命周期 |
| Solana Pulse 可离线验证 | **是** | 其 `check_tx` 接受 base64、signed or not，`network` 支持 `devnet`；免费 25 次/天 |

补充：Pulse 仓库 MIT、目前 1 star、托管在 GCP；付费档是 **Solana mainnet** 上的 x402（$0.02/次）。MoneySwitch 当时未启用 Solana mainnet（2026-10-25 起可显式开启），**无法用自己的支付链路付费**；免费额度或 6 周 trial 都不是长期方案。把 payer 公钥、收款方、金额发给第三方也是一次需要拍板的数据流。

## 4. 一条最小接入路径

目标：让审批人看懂“这笔付款的真实影响”，不扩展成安全产品，不接 runtime 外部依赖。

### Step 1 — 审批页说全本地已有的事实（1–2 天，纯现有链路）

- server：`approvalFields` 增加服务端计算好的展示字段（页面不解析，遵守既有约定）：完整的 `pay_to`、`asset` 对应的 USDC 标识、`pay_to` 的区块浏览器链接（复用 `explorerUrl()`，[networks.ts](../packages/x402/src/networks.ts#L113-L115)）。如要显示 sponsor，再在 `createApproval` 多存一个 `fee_payer`（来自 `selectedRequirements.extra.feePayer`）；不存也不影响结论。
- dashboard：`ApprovalSummary` 一处改，管理员卡片和审批链接同时生效（[ApprovalsPage.tsx](../apps/dashboard/src/pages/ApprovalsPage.tsx#L70-L128)）：
  - 收款方显示完整地址（等宽 + 可复制），不再只给 `6+4` 截断；
  - 一句人话：“批准后 AI 会签一笔 **0.15 USDC 到 `<完整地址>`**（Solana Devnet）；不含代币授权、不花你钱包的 SOL；链上失败不扣 USDC，额度在链上确认后释放。”
  - 保留金额、链、URL、倒计时、key 额度上下文；中英文案进 `approvalsStrings`。
- 静态声明必须有测试背书：在 `solana.test.ts` 里解码已签名交易，断言指令集恰为 `[SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo]`，且 `feePayer ≠ payer`。这样“只转账”不是文案承诺，是回归测试。

### Step 2 — 补一次 Devnet 真机审批闭环（当前最大证据缺口）

- 复用 `scripts/demo-solana-devnet.mjs` 与 `.data/solana-live/`：给 payer 充 Circle Devnet USDC、给 sponsor 充 Devnet SOL，跑 **approval_required → 批准 → 带 `approval_id` 重发 → settled**。
- 验收物：Devnet explorer 的 tx 链接；payer 余额变化只有 USDC（SOL 不变）；sponsor 付 fee；写回 `docs/solana.md` 的 “Verification / 边界” 两节。没有这一步，审批页上任何 Solana 文案都只是纸上谈兵。
- 加分（可选，不是本路径验收项）：同一笔用 `getAccountInfo` 看收款方 ATA 是否存在——失败预测在本地一次 RPC 就能做，不需要外部服务。

### Step 3 — 只用一次离线对照评估 Pulse（决定要不要继续，而不是接入）

- 用 Step 2 那笔构造出的 **unsigned base64 交易**（`serialize({ requireAllSignatures: false })`）调一次 `POST /api/tools/check_tx`，`network: "devnet"`；免费额度足够，不必用 trial key。
- 记录：`checks[]` / `balance_changes` / `fee` 里有哪些是**我们从 402 accept 推不出来**的；对 unsigned tx 与 devnet 的实际接受度；延迟；错误率。
- 继续的门槛（同时满足才谈 runtime）：① 至少 1 条我们推不出、且对审批人有用的事实；② 未来 6 个月有 Solana 主网或“卖家提供任意交易”的计划。否则在 issue 里回复“问题成立、方案不匹配”，结束。

## 5. 可复用部分

- 审批数据与 API：`approvals` 表、`createApproval`、`approvalFields`；`asset` 已存已返回，`explorerUrl()` 现成。
- 页面：`ApprovalSummary` 同时服务管理员卡片与审批链接；`NetworkKindPill`、`approvalsStrings`（en/zh）。
- 流程锚点：`client.ts` 的 `onBeforePaymentCreation` 里已有 `selectedRequirements`（fee payer 就在 `extra`）；`validateApprovalForUse` 是“显示 = 绑定”的锚点。
- 证据工具：`solana.test.ts` 的 mock RPC harness（[solana.test.ts](../packages/x402/test/solana.test.ts#L34-L68)）可直接加指令集断言；`scripts/demo-solana-devnet.mjs`；`reconcilePaymentToFailed` 的失败释放逻辑。
- 文档：`docs/solana.md` 的边界声明照实更新即可。

## 6. 需要新增的证据（验收清单）

1. 指令集断言测试：exact-SVM 签名交易只有 `[ComputeUnitLimit, ComputeUnitPrice, TransferChecked, Memo]`，`feePayer ≠ payer`。
2. 显示与绑定一致性：审批页展示字段 ⊆ `validateApprovalForUse` 校验字段（server 字段测试 + dashboard 渲染测试）。
3. Devnet 真机一笔：approval → approve → settled，tx signature + explorer + payer/sponsor 余额差（失败一笔更好）。
4. Pulse 一次性对照记录：unsigned/devnet 是否真支持、多出什么事实、延迟、数据流边界。
5. 若要长期用 Pulse：付费通道是 Solana mainnet x402；Solana mainnet 现在可以显式开启，但仍需要一笔真钱付款验证，而且不应把审批页依赖建在外部服务上。

## 7. 暂不应承诺的能力

- 不做 drainer 检测/拦截；即使未来接 Pulse，`OK/REVIEW/BLOCK` 也只是提示且 fail-open，不做审批门禁。
- 不承诺“dry-run 成功 = 最终一定成功”（blockhash 重取、链上状态会变）。
- 不承诺失败手续费的精确数字或退款（fee 由 sponsor 付，额度在链上确认后释放）。
- 不承诺 Solana 主网、任意交易解析、MagicBlock。
- 不承诺第三方 SLA / 长期免费（25 次/天、6 周 trial 都不是产品方案）。
- 不把审批页的“真实影响”包装成安全审计或合规背书。

## 8. 对 issue 的回复口径（英文，可直接用）

> Thanks — the problem is real: the approval page today shows the amount, chain, URL and a shortened payee, and nothing about what the payment can do. But on this path the approval is created from the 402 quote before any transaction exists; the Solana transaction is built and signed only after approval, and under the `exact` SVM scheme it is always the same fixed instruction set (compute budget, one USDC `transferChecked`, memo) with the facilitator sponsoring the fee. So there is no drainer pattern for a dry-run to find here. We will do the small version first: show the full recipient/mint and the fixed facts on the approval screen, plus one funded Devnet approval-to-settlement run. We may use `check_tx` as a one-off offline comparison to see whether it adds anything we cannot derive from the quote, but not as a runtime dependency for now. Thanks for the trial-key offer — not needed for that.

## 附：外部信息核验

- issue #24：2026-10-19T23:54Z 创建，作者 `Timothymycompc`（`author_association: NONE`），0 评论，label `enhancement`。
- Pulse 仓库：MIT，1 star，2026-08-30 创建，2026-10-23 推送；托管端点 `https://solana-pulse-gateway-1021990235790.us-central1.run.app`。
- `check_tx` 契约（`GET /api/tools/check_tx`）：`tx` = base64（signed or not，legacy/v0/v1），`network` = `mainnet-beta | devnet`，默认 mainnet；输出 `verdict / checks / balance_changes / fee / simulation`。
- 定价：25 次免费/天 → $0.02/次，x402 v2 `exact`、USDC on **Solana mainnet**；作者在 issue 里另给 6 周 unlimited trial key。

## 9. 实施状态（2026-10-25）

Step 1 已落地，Step 2/3 仍未做：

- 数据：迁移 `0014_approval_fee_payer` 给 `approvals` 加 `fee_payer`（可空、无回填；`apps/server-pkg/migrations/` 同步副本）。Solana 审批创建时从报价的 `extra.feePayer` 写入，EVM 和新域名审批为 null。
- API：`approvalFields` 增加 `network_family`、`asset_label`、`pay_to_url`、`fee_payer`，全部由服务端计算（页面不解析 CAIP-2 / 地址 / URL）。
- 页面：管理员审批卡片与审批链接共用的 `ApprovalSummary` 新增事实块——完整收款方（可复制 + 浏览器链接）、资产与 mint、按链型分流的“只签一笔 USDC 转账 / 不含代币授权 / 不花 ETH 或 SOL”、失败不扣 USDC、Solana 手续费赞助方。
- 测试：x402 在已签名交易上断言 exact-SVM 指令集恰好为两条 compute-budget + 一条 `TransferChecked` + 一条 memo，且 `feePayer` 仍是赞助方；审批记录断言 `feePayer`；server 断言 Solana 审批链接返回的字段（大小写原样、Devnet explorer URL）；dashboard 覆盖 EN/ZH、EVM 与 Solana 渲染、host 审批没有事实块。`SPEC.md` §3、`docs/solana.md`、`CHANGELOG.md` 已同步。
- 仍未做：Step 2 的 Devnet `approval → settle` 真机（需 funded payer USDC + sponsor SOL，`.data/solana-live/` 仍未生成）；Step 3 的 Pulse `check_tx` 一次性对照（trial key 未用）。2026-10-25 已在项目的美国部署（revision `0c0e093`）上完成一笔真机 Solana 主网付款（`0.005` USDC，经人工审批，finalized）和一笔 Devnet `0.01` 测试币付款，证据见 `docs/updates/2026-10-25-solana-live-payments.md`；注意该部署跑的是另一条分支的发布版本，本仓库 `main` 的提交尚未部署。
