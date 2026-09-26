# MoneySwitch v0.4 — 子 Key（多级分配）+ 本机桌面控制台（增量规格，冲突时以本文件为准）

## 0. 一句话

服务器发给员工一把 MoneyKey，员工在本机「MoneySwitch 桌面控制台」里一键把它切成每个 Agent 一把子 Key，并在同一张卡片上配置该 Agent 的**模型 Key（大脑）**与**MoneyKey（钱包）**，点「启用」写入配置。子 Key 可以继续往下切（多级 switch）。

## A. 子 Key / 多级分配（后端，apps/server + packages/core + packages/db）

### 数据
- `money_keys` 新增：`parent_id`（nullable，FK money_keys.id）、`depth`（根=0）、`can_delegate`（bool，默认 false）、`created_by`（`admin` | `key:<id>`）。新 migration，不改旧 migration。
- 最大深度 `MONEYSWITCH_MAX_KEY_DEPTH`，默认 3（根 + 3 级子）。

### 创建子 Key
- `POST /v1/keys/children`（**MoneyKey 鉴权**，调用者 = 父 Key）：body `{ name, daily_budget, total_budget, per_request_limit, approval_threshold?, allowed_hosts?, allowed_models?, expires_at?, can_delegate? }`。
  - 父 Key 必须 enabled、未过期、`can_delegate=true`、`depth < MAX`。
  - 子 Key 各项上限**不得超过**父 Key 对应上限（daily/total/per_request；allowed_hosts/allowed_models 必须是父的子集；expires_at 不得晚于父；父的 approval_threshold 为 X 时子的阈值不得高于 X 或为空=继承父）。违反 → 400 `CHILD_EXCEEDS_PARENT` + 指明字段。
  - 子 Key 的 `can_delegate` 只有在父允许时才可为 true。
  - 返回完整 key（仅一次）。审计 `key.child_create`，actor=`key:<parentId>`。
- `GET /v1/keys/children`（MoneyKey 鉴权）：列出调用者**直接子 Key**（含 used_today/used_total，不含 hash）。
- `POST /v1/keys/children/:id/revoke`（MoneyKey 鉴权）：只能撤销自己**子树内**的 Key。
- 管理员 `POST /v1/keys` 新增可选 `can_delegate`；`GET /v1/keys` 返回 `parent_id`、`depth`、`can_delegate`、`children_count`；新增 `GET /v1/admin/keys/tree` 返回树。

### 策略（最关键，必须在同一个 SQLite 事务里）
- 子 Key 付款时，`evaluateAndReserve` 沿祖先链**逐级**检查：自身及每个祖先的 enabled/未过期、per_request、daily、total（祖先的已用 = 其整个子树的 settled+reserved+unknown 之和）。任何一级不满足 → 拒绝，错误码与现有一致，另附 `limit_scope: "self" | "ancestor"` 与 `limit_key_prefix`。
- 审批：自身或任一祖先的 approval_threshold 被触发即需审批；审批仍由管理员在 Dashboard 处理（v0.4 不做父 Key 持有人审批）。
- 撤销/禁用/过期**向下级联生效**：祖先无效 → 全部子孙立即不可用（查询时沿链判断即可，不必批量改行）。
- 并发测试：父 daily=1.00，两个子 Key 各 daily=1.00，同时各发 5 笔 0.15 → 全树合计恰好 6 笔成功。

### Dashboard
- 管理员：Money Keys 列表显示树形缩进（父/子），可展开；创建 Key 时有「允许员工再分配（可切子 Key）」开关；Overview 的 Agent 用量按根 Key 汇总并可展开子 Key。
- 员工视图：新增「我的子 Key」页：列出、创建（上限提示=父剩余）、撤销；显示每个子 Key 今日用量。

## B. 本机桌面控制台（apps/cli 扩展，Apache-2.0）

### 形态
- `npx moneyswitch ui`（从服务器 tarball 或将来 npm 发布）：在 `127.0.0.1:4318`（可配）启动**本机** Web 控制台并自动打开浏览器。纯本机，不连公网（除用户配置的 MoneySwitch 服务器与模型提供商校验请求）。
- 本机 UI 的鉴权：启动时生成一次性会话 token，以 `http://127.0.0.1:4318/#<token>` 打开（token 在 fragment，不进日志），UI 换成 httpOnly cookie；所有写配置的 API 必须带该会话。原因：本机 Agent 同样能访问 127.0.0.1，不能让它们静默改写别的 Agent 配置。
- Tauri 桌面壳留到后续；v0.4 用本机 Web UI。

### 界面（参照 EchoBird / CCSwitch，但多一维「钱包」）
1. **顶部：MoneySwitch 账户**：服务器地址 + 我的 MoneyKey（粘贴一次，存本机 `~/.moneyswitch/desktop.json`，文件权限仅当前用户；key 在界面掩码显示）→ 显示我的今日剩余/总剩余、是否可分配。
2. **Agent 卡片网格**（自动探测本机已安装的）：Claude Code、Codex、WorkBuddy、OpenClaw、Cherry Studio（后两者如无法自动写配置则给手动步骤）。每张卡片两栏：
   - **大脑（模型）**：提供商预设（Anthropic 官方 / OpenAI 官方 / OpenRouter / DeepSeek / 自定义 Base URL）+ API Key + 模型名；「测试连接」按钮（发一个最小请求，显示成功/失败）。**v0.4 可以只做 Claude Code 与 Codex 的模型配置写入**，其余显示「即将支持」。
   - **钱包（MoneyKey）**：「用我的 Key 切一把子 Key 给它」：每天 $__、单次 $__（默认值=父剩余的合理比例，不得超父），点一下调用 `POST /v1/keys/children` 生成；或粘贴现成 mk_live_。
   - 底部「启用」开关：打开时展示**将要写入的配置 diff**（每个文件、每个字段，Key 掩码），确认后写入（写前备份 `.bak-<时间戳>`）；关闭时恢复/移除 MoneySwitch 写入的部分。
3. **状态**：每张卡片显示「已启用 / 未启用 / 配置被外部修改」、今日该子 Key 花费。
4. **一键全配**：「把我的 Key 平均切给所有已探测到的 Agent 并启用」→ 先预览 diff，再确认。

### 各 Agent 写入内容（实现前必须用本机真实版本核实格式，核实不了就不自动写，只给手动步骤）
- Claude Code：模型 → `~/.claude/settings.json` 的 `env`（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`）；钱包 → `claude mcp add moneyswitch -s user …`（沿用 connect 逻辑）。
- Codex：模型 → `~/.codex/config.toml` 的 `model`、`model_provider` 与 `[model_providers.<id>]`（base_url、env_key / wire_api 以当前 codex 版本为准）；钱包 → `[mcp_servers.moneyswitch]`。
- WorkBuddy / OpenClaw：调研其配置位置与格式；能可靠写就写，不能就手动步骤。

### 安全
- 模型 Key 与 MoneyKey 只存本机、只写入对应 Agent 的配置，不上传 MoneySwitch 服务器。
- 所有写操作：预览 diff → 用户确认 → 备份 → 写入 → 校验（重新读回解析成功）；失败自动回滚备份。
- 测试一律在临时 HOME/USERPROFILE/CODEX_HOME 下进行；**绝不修改运行机器上真实的 ~/.claude*、~/.codex/**。

## C. 验收
- A：单测覆盖子 Key 创建约束（每个字段越界）、祖先链扣额、祖先撤销级联、深度上限、并发全树合计、子树外撤销被拒；e2e：管理员建可分配根 Key → 员工 Key 切子 Key → 子 Key 付款 → 父/根用量同时增加 → 撤销根 → 子 Key 付款 KEY_REVOKED（limit_scope=ancestor）。
- B：在临时 HOME 下端到端：启动 ui → 用会话 token 登录 → 粘贴员工 Key → 为 Claude Code、Codex 各切子 Key 并配置模型（用假的模型 key，测试连接失败也能继续）→ 启用 → 检查写入文件与备份 → 禁用 → 恢复。Playwright 截图全流程。
- 全仓库 `pnpm build/test/test:e2e` 绿。
