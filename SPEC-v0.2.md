# MoneySwitch v0.2 — OpenAI / NewAPI 兼容层（SPEC.md 的增量，冲突时以本文件为准）

## 0. 目标一句话

**MoneyKey 直接当 OpenAI API Key 用。** 任何 OpenAI 兼容客户端（openai SDK、Cherry Studio、Open WebUI、NextChat、NewAPI 的上游渠道）填 `Base URL = http://127.0.0.1:4020/v1`、`API Key = mk_live_…` 即可对话；每次调用由 MoneySwitch 通过 x402 在 Monad 上用 USDC 付给卖方，用量像 token 一样可见。

不发明新东西：客户端协议 = OpenAI Chat Completions；结算 = x402 exact；余额查询 = OpenAI 旧版 billing 接口（NewAPI 也实现了同样两条）。

## 1. 新概念：Channel（参照 NewAPI 的「渠道」）

Channel = 一个说 OpenAI 协议、用 x402 收费的上游。

`channels` 表：id, name, base_url（如 `http://127.0.0.1:4021/v1`）, models(JSON 字符串数组), enabled, created_at。

管理 API（admin token）：
```text
GET    /v1/admin/channels
POST   /v1/admin/channels          { name, base_url, models: [] }
PATCH  /v1/admin/channels/:id      { enabled?, models?, name? }
DELETE /v1/admin/channels/:id
```
Channel 的 base_url 的 host:port **自动视为允许的出站目标**（仅对网关路径生效；SSRF 自身端口规则仍然生效，不可被放行）。

MoneyKey 新增可选字段 `allowed_models`（JSON 数组，null = 允许所有已启用 channel 的模型）——对应 NewAPI 的「模型限制」。创建/列表接口透出该字段。

## 2. OpenAI 兼容网关（MoneyKey 鉴权，Bearer）

```text
GET  /v1/models                               OpenAI list 格式，只列该 key 可用的模型
POST /v1/chat/completions                     见下
GET  /v1/dashboard/billing/subscription       旧版 OpenAI billing 格式
GET  /v1/dashboard/billing/usage              旧版 OpenAI billing 格式
```

### POST /v1/chat/completions 流程
1. 与 `/v1/fetch` 相同的 key 检查（enabled/过期/每分钟次数）。
2. 按 `model` 找到启用中的 channel（多个命中取第一个）；找不到 → 404 OpenAI 错误格式 `model_not_found`；key 的 allowed_models 不含 → 403 `model_not_allowed`。
3. 复用现有 `performPaidFetch` 的策略 + x402 流程（**不要另写一套支付逻辑**；如需把「读 body 成字符串」与「路径/方法」参数化就重构它，保持 `/v1/fetch` 行为与测试不变）。向上游一律发**非流式**请求（强制 `stream:false`）。
4. 如果客户端请求 `stream:true`：MoneySwitch 以 SSE 返回：一个 `chat.completion.chunk`（delta.role+content 为完整内容）、一个带 `finish_reason` 的结束 chunk、`data: [DONE]`。否则原样返回上游 JSON。
5. 在返回给客户端的 JSON 里（非流式）附加字段 `"moneyswitch": { "cost": "0.01", "currency": "USDC", "tx_hash": "0x…", "network": "eip155:10143", "remaining_today": "…" }`；同时加响应头 `X-MoneySwitch-Cost`、`X-MoneySwitch-Tx`。流式时只加响应头。
6. 策略拒绝时返回 OpenAI 错误格式：HTTP 402（预算类：PER_REQUEST_LIMIT_EXCEEDED/DAILY/TOTAL/MAX_PRICE）、403（KEY_REVOKED/KEY_EXPIRED/model_not_allowed）、401（KEY_INVALID）、429（RATE_LIMITED）、409 + `approval_id`（APPROVAL_REQUIRED）。body：`{ "error": { "message": "人类可读说明", "type": "moneyswitch_policy", "code": "<错误码>", "approval_id"?: "…" } }`。
7. payments 表新增列：`kind`（`fetch|chat`，默认 fetch）、`model`、`prompt_tokens`、`completion_tokens`（从上游 usage 取，可空）。`/v1/history`、`/v1/admin/usage` 透出这些列。

### billing 接口（与 NewAPI / OpenAI 旧版一致）
- subscription：`{ "object":"billing_subscription", "has_payment_method":true, "soft_limit_usd":<total_budget>, "hard_limit_usd":<total_budget>, "system_hard_limit_usd":<total_budget>, "access_until":<expires_at 秒，或 0> }`
- usage：`{ "object":"list", "total_usage": <已用总额 × 100，单位美分，数字> }`（忽略 start_date/end_date 也可，写明）

## 3. demo-seller：x402 收费的 LLM 服务

- `GET /v1/models`（免费）：返回 `moneyswitch-demo-chat`。
- `POST /v1/chat/completions`，x402 价格 **0.01 USDC/次**（exact）。
- 后端：若设置了 `DEMO_LLM_UPSTREAM_KEY`（OpenRouter key），转发到 `https://openrouter.ai/api/v1/chat/completions`，模型 `DEMO_LLM_UPSTREAM_MODEL`（默认 `deepseek/deepseek-v4.1-flash`（2026-09-25 实查 OpenRouter 存在，约 $0.15/$0.6 每百万 token）；启动时若不可用就报错退出并提示换模型），带回 usage；**未设置时**返回确定性的 echo 回复（"[demo] You said: …"）+ 伪 usage，用于离线测试与 e2e。
- key 只从环境变量读，永不写入日志和仓库。

## 4. Dashboard（成熟交互，参照 NewAPI）

1. **Channels** 页：表格（名称、base URL、模型 tag、状态开关、删除）、「Add channel」抽屉（预填 demo：`Demo LLM (x402)` / `http://127.0.0.1:4021/v1` / `moneyswitch-demo-chat`，可点「从上游拉取模型」调 base_url 的 /models）。
2. **Playground** 页（NewAPI 也有）：选一把 key（前端只存 sessionStorage，由用户粘贴 mk_live_，默认空）、选模型、对话窗；每条助手消息下方显示小字 `$0.01 · tx 0x1c83…4d4d ↗ · 123 tokens`；右侧面板实时显示该 key 今日 used/limit 进度条。策略拒绝时以红色系统消息显示错误码与说明，审批需要时显示「Waiting for approval」+ 跳转 Approvals 的按钮。
3. **Money Keys** 创建抽屉：新增「Allowed models」多选（来自 channels）；创建成功页 tabs 增加 **OpenAI / NewAPI client**：展示 `Base URL: http://127.0.0.1:4020/v1` 与 `API Key: mk_live_…`，外加 openai Python / Node / curl 三段示例，以及「在 NewAPI 里添加为 OpenAI 类型渠道」的说明。
4. **Usage** 页：新增 Type（fetch/chat）、Model、Tokens 列；Overview 的 Recent activity 显示模型名。
5. **Connect Agent** 页：新增 Cherry Studio / Open WebUI / NewAPI 卡片（都用 Base URL + Key 模式，标 Ready）。

## 5. 测试（离线必须全绿）

- 网关单测/e2e：用 echo 模式的 demo-seller + mock-facilitator：
  - openai 官方 Node SDK（devDependency `openai`）以 `baseURL=http://127.0.0.1:<port>/v1, apiKey=mk_live_…` 调 `chat.completions.create` 非流式 → 得到回复且 `moneyswitch.cost == "0.01"`，usage +0.01，payments 行 kind=chat、model 正确；
  - 同 SDK `stream:true` → 能正常迭代出完整内容；
  - `models.list()` 只列允许的模型；allowed_models 不含 → 403 code model_not_allowed；
  - 预算不足 → 402 + code DAILY_BUDGET_EXCEEDED，且无付款；
  - billing subscription/usage 数值正确；
- `/v1/fetch` 既有测试保持全绿。

## 6. 不做

按 token 计价（`upto` scheme）、多 channel 负载均衡/重试、embeddings/images/audio 接口、Responses API、真实 SSE 透传。这些列入 v0.3。
