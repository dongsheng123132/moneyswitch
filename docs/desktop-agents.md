# 桌面控制台：各 Agent 的配置格式调研（SPEC-v0.4 §B）

- 日期：2026-09-26，调研机器：Windows 11，Node 22 / 24。
- 结论只对下面列出的**版本**负责；Agent 升级后先重跑验证脚本再改代码。
- 所有验证都在临时目录里做（`HOME` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `CODEX_HOME` /
  `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 全部指向 `.data/desktop/research/…`，并清掉本 shell 的
  `CLAUDE_*` / `ANTHROPIC_*` / 代理变量），没有读写本机真实的 `~/.claude*`、`~/.codex/`、`~/.openclaw/`。

复现：

```bash
node apps/cli/scripts/verify-agent-formats.mjs      # Claude Code + Codex，结果写入 .data/desktop/research/report.json
node apps/cli/scripts/desktop-e2e.mjs               # 控制台全流程（Playwright），日志 .data/desktop/e2e-log.json
```

| Agent | 实测版本 | v0.4 控制台 | 原因 |
|---|---|---|---|
| Claude Code | 2.1.280 | **自动写入**（大脑 + 钱包） | 格式经本机真实 CLI 读回验证 |
| Codex CLI | codex-cli 0.156.1 | **自动写入**（大脑 + 钱包） | 同上 |
| OpenClaw | 2026.9.3 (1391f7c) | 手动步骤（给出 `openclaw config patch` 文件与命令） | 格式已验证，但 v0.4 只按 SPEC 自动写 Claude/Codex；交给 OpenClaw 自己的 CLI 写更稳 |
| WorkBuddy | 已安装（版本号无 CLI 可查） | 手动步骤 | 配置文件位置各来源说法不一，无法在不启动 GUI 的情况下验证被读取 |
| Cherry Studio | 已安装 | 手动步骤 | 配置存在 Electron 本地存储（IndexedDB/LocalStorage），不是可安全编辑的文件 |

---

## 1. Claude Code 2.1.280

### 写什么
- **大脑** → `~/.claude/settings.json` 的 `env`（有 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/settings.json`）：
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_API_KEY`（以 `X-Api-Key` 头发送，用于 Anthropic 官方）**或** `ANTHROPIC_AUTH_TOKEN`（以 `Authorization: Bearer` 发送，用于 OpenRouter / DeepSeek / 自定义网关）；另一个会被移除（停用时恢复），避免旧 Key 被错误地发往新地址
  - `ANTHROPIC_MODEL`（可空 = Agent 默认）
  - 其他 `env` 键和 settings.json 的其他字段原样保留。
- **钱包** → `claude mcp add moneyswitch -s user -e MONEY_API_BASE=… -e MONEY_API_KEY=… -- <mcp 命令>`
  （复用 `moneyswitch-connect` 的 `applyClaude`），Claude Code 自己把它写进 `~/.claude.json` 的
  `mcpServers.moneyswitch`（有 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/.claude.json`）。

### 来源
- [Settings files and precedence](https://code.claude.com/docs/en/settings)：用户级 `~/.claude/settings.json`；
  Windows 上 `~` = `%USERPROFILE%`；`CLAUDE_CONFIG_DIR` 改变这些文件的位置；`~/.claude.json` 保存 MCP 服务器配置。
- [Environment variables](https://code.claude.com/docs/en/env-vars)：`ANTHROPIC_API_KEY`「sent as `X-Api-Key` header」；
  `ANTHROPIC_AUTH_TOKEN` 的值「will be prefixed with `Bearer `」；`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`；这些变量可以写在 settings.json 的 `env` 里。
- `claude mcp --help`（2.1.280）：`add [options] <name> <commandOrUrl> [args...]`，`-e KEY=value`，`-s user`。

### 验证（`verify-agent-formats.mjs`，临时 HOME）
1. 写 `settings.json`：`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<mock>/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-fake-claude-authtoken-0000","ANTHROPIC_MODEL":"claude-sonnet-4-5"}}`，
   运行 `claude -p OK`：本地假模型服务收到 `POST /anthropic/v1/messages?beta=true`，
   `Authorization: Bearer sk-fake-claude-autht…`，`model: "claude-sonnet-4-5"`，CLI 输出假服务返回的 `MOCK_OK`，退出码 0。
   （之前还有一个 `HEAD /anthropic/api/hello`。）
2. `claude mcp add moneyswitch -s user -e … -- node -e 0` 输出
   `File modified: …\research\home-…\.claude.json`；`claude mcp get moneyswitch` 显示 `Scope: User config`。
3. 设 `CLAUDE_CONFIG_DIR=<tmp>/alt` 再 `claude mcp add`：输出 `File modified: …\alt\.claude.json`（不在 HOME 根目录）。
4. 观察：模型名写成 Claude Code 不认识的值时（如 `mock-claude-model-from-settings`），CLI 在 stderr 打印
   `isn't described by this version's model catalog` 警告但仍会发请求；所以控制台给的建议模型名只用已被识别的。
5. 端到端（`desktop-e2e.mjs`）：由控制台写入后，在同一临时 HOME 里 `claude -p OK` 请求到了控制台写入的 base URL，
   Bearer 前缀 `sk-fake-claude`、model `claude-sonnet-4-5`；`claude mcp get moneyswitch` 显示 `√ Connected`，
   `MONEY_API_KEY` 是切出来的子 Key（不是员工的父 Key）。

---

## 2. Codex CLI 0.156.1

### 写什么（`~/.codex/config.toml`，有 `CODEX_HOME` 时是 `$CODEX_HOME/config.toml`）

```toml
model = "gpt-6-sol"                       # 根级键，插在第一个表之前（已有则原位替换）
model_provider = "moneyswitch_brain"

[model_providers.moneyswitch_brain]
name = "MoneySwitch · openai"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-…"

[mcp_servers.moneyswitch]                 # 与 moneyswitch connect 写的完全相同（buildMcpSection）
command = "node"
args = ["…/apps/mcp/dist/index.js"]

[mcp_servers.moneyswitch.env]
MONEY_API_BASE = "http://…"
MONEY_API_KEY = "mk_live_…"
```

- 只做行级编辑，不重排用户文件（保留注释、CRLF、空行）；写后用 TOML 解析器（smol-toml）重新解析，
  **去掉我们管理的键后必须与写前完全相等**，否则拒绝写入。
- `experimental_bearer_token` vs `env_key`：两者都实测可用。`env_key` 要求用户在系统环境变量里放 Key，
  对桌面用户（从开始菜单/IDE 启动 Codex）不可靠，所以控制台用 `experimental_bearer_token`；
  官方文档把它标为不推荐（discouraged），Key 因此以明文存在 config.toml 里 —— 与 Claude Code 的 settings.json 相同的暴露面。

### 来源
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)（原 `developers.openai.com/codex/config-reference`，308 跳转）：
  `model`、`model_provider`、`[model_providers.<id>]` 的 `name / base_url / env_key / wire_api / requires_openai_auth / experimental_bearer_token …`；
  `wire_api`：`"responses"` 是「the only supported value」；`[mcp_servers.<id>]` 的 `command / args / env`；`CODEX_HOME` 默认 `~/.codex`。
- `codex --help` / `codex mcp --help` / `codex doctor --help`（0.156.1）。

### 验证（临时 CODEX_HOME）
1. `codex mcp list --json` 列出 `moneyswitch`，`transport.env` 为写入的 `MONEY_API_BASE / MONEY_API_KEY`。
2. `codex doctor --json`：`config.load: ok: config loaded`，`auth.credentials: ok: OpenAI auth is not required for the active model provider`，
   `mcp.config: ok: MCP configuration is locally consistent`；`app_server.status` 的 control socket 与 daemon 目录都在临时 CODEX_HOME 下（证明没连到本机真实的 Codex 后台）。
3. `codex exec --skip-git-repo-check OK`：假 Responses 服务收到 `POST /openai/v1/responses`，
   `Authorization: Bearer sk-fake-codex-bearer…`，`model: "mock-codex-model"`（experimental_bearer_token 生效）。
4. `-c model_provider=moneyswitch_envkey`（`env_key = "MS_FAKE_OPENAI_KEY"`）同样收到 `Bearer sk-fake-codex-envkey…`。
5. 把 `wire_api` 改成 `"chat"`：退出码 1，
   `Error loading config.toml: wire_api = "chat" is no longer supported. How to fix: set wire_api = "responses"`。
   → **只提供 Chat Completions 的提供商（如 DeepSeek 官方接口）不能直接给 Codex 用**，控制台选 DeepSeek 时给出警告并建议先测试连接。
6. `codex --strict-config mcp list` → `--strict-config is not supported for codex mcp`（所以用 doctor 的 `config.load` 作为读回校验证据）。
7. 端到端：控制台写入后 `codex mcp list --json` 同时看到用户原有的 `filesystem` 和新的 `moneyswitch`（子 Key），doctor `config loaded`。

---

## 3. OpenClaw 2026.9.3（手动步骤）

- 配置文件：`~/.openclaw/openclaw.json`（JSON5；`OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR` / `--profile` 可改），
  `openclaw config file` 打印当前路径。
- 模型：`models.providers.<id> = { baseUrl, apiKey, api: "openai-completions" | …, models: [{ id, name }] }`，
  默认模型 `agents.defaults.model.primary = "<provider>/<model>"`。
- MCP：`mcp.servers.<name> = { command, args, env }`（`openclaw mcp set|list|show`）。
- 验证（临时 `OPENCLAW_STATE_DIR`）：把 provider + 默认模型 + `mcp.servers.moneyswitch` 写成一个 JSON5 补丁，
  `openclaw config patch --file moneyswitch.json5 --dry-run` →「Dry run successful: 10 update(s) validated」；
  去掉 `--dry-run` →「Applied 10 config update(s)」；`openclaw config validate` →「Config valid」；
  `openclaw mcp list` 列出 `moneyswitch`；`openclaw models list` 显示 `moneyswitch_brain/deepseek-chat … default`。
  本机真实 `~/.openclaw/openclaw.json` 的 mtime 验证前后不变。
- 为什么仍是手动：SPEC v0.4 只要求 Claude/Codex 自动写；OpenClaw 自带带校验和备份的 `config patch`，
  让用户用它自己的命令写比我们直接改 JSON5 更稳。控制台生成补丁内容（钱包 Key 在界面上掩码，复制按钮复制完整值）和三条命令。
- 来源：`openclaw --help`、`openclaw config --help`、`openclaw mcp --help`（2026.9.3），[docs.openclaw.ai/cli/config](https://docs.openclaw.ai/cli/config)。

## 4. WorkBuddy（手动步骤）

- 本机观察（只列文件名）：`~/.workbuddy/models.json`（空数组）、`~/.workbuddy/mcp.json`（`{"mcpServers":{}}`）、`~/.workbuddy/settings.json`。
- 官方 CodeBuddy 文档写的自定义模型文件是 `~/.codebuddy/models.json`（`{ "models": [{ id, name, vendor, apiKey, url, … }] }`，`url` 写完整的 `/v1/chat/completions`），
  第三方教程写 `url` 到 `/v1` 为止；本机实际的 `~/.workbuddy/models.json` 又是数组形状 —— 三者不一致。
- 无法在不启动 GUI 的情况下确认 WorkBuddy 读取了哪一个文件，所以不自动写；控制台给出：MCP JSON（`mcpServers.moneyswitch`）+ 「设置 → 模型 → 添加自定义模型」要填的 Base URL / Key。
- 来源：[CodeBuddy models.json 配置指南](https://www.codebuddy.cn/docs/ide/Features/models)、[WorkBuddy 模型配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)、
  [第三方排错清单](https://crazyrouter.com/zh/blog/workbuddy-models-json-troubleshooting-crazyrouter)。

## 5. Cherry Studio（手动步骤）

- 本机 `%APPDATA%\CherryStudio\` 下只有 `config.json`（仅 `theme`）+ Electron 的 `IndexedDB/`、`Local Storage/`；提供商与 MCP 配置在应用内部存储里，不是可安全编辑的文件。
- 应用支持 `cherrystudio://providers/api-keys?v=1&data=<base64url JSON>` 深链导入提供商（[New API 的 Cherry Studio 文档](https://docs.newapi.pro/en/docs/apps/cherry-studio)、
  [cherry-studio commit ff72c00](https://github.com/CherryHQ/cherry-studio/commit/ff72c007c03ff47de21a4d0bf52a1ff1fb35cd89)），但 JSON 字段未在公开文档里定义，本次未验证 → 不使用。
- 控制台给出：「设置 → MCP 服务器 → 添加 → 从 JSON 导入」要粘贴的 JSON + 「模型服务 → 添加（OpenAI 兼容）」要填的 Base URL（`<服务器>/v1`）/ Key。

---

## 6. 控制台的写入协议（所有自动写入的 Agent 共用）

1. **预览**：`POST /api/agents/:id/preview` 计算每个文件、每个字段的 前 → 后（Key 掩码），并返回 `planId`
   （= 当前文件内容哈希 + 目标配置哈希）。不写任何东西。
2. **确认**：`POST /api/agents/:id/apply {planId}`；服务端重新计算，`planId` 不一致（预览后文件被改过）→ 409，界面自动重新预览。
3. **备份**：每个将被修改的文件先复制为 `<文件>.bak-<epoch ms>`（与 `moneyswitch connect` 相同的命名）；
   `~/.claude.json` 在调用 `claude mcp add` **之前**备份。
4. **写入 + 读回**：写完重新读取并解析（JSON / TOML），检查管理的字段等于期望值；Codex 还检查未管理部分语义不变。
5. **失败回滚**：任何一步失败，本次事务里所有文件从备份恢复（原本不存在的文件删除）。
6. **停用**：恢复第一次写入前记录的原值（不是上一次写入的值）；原本没有的键/表删除；
   原本存在的 `moneyswitch` MCP 条目（例如之前 `moneyswitch connect` 写的）放回去。
7. **状态**：记录写入值的指纹；读出的值与指纹不符 → 「配置被外部修改」。
