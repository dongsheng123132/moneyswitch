# MoneySwitch v0.3-lite — 员工端 & 桌面一键接入（增量规格）

## 角色

| 角色 | 拿什么 | 在哪用 | 能做什么 |
|---|---|---|---|
| 管理员（老板/财务/个人用户自己） | `ms_admin_…` | Dashboard（服务器或本机 4020） | 钱包、渠道、给每个员工的每个 Agent 开 Key、审批、看全公司用量 |
| 员工 | 一把或几把 `mk_live_…` | Dashboard「我的额度」视图 + 桌面 CLI | 看自己额度/流水、Playground、把 Key 一键配进本机 Agent；**不能**看别人、不能碰钱包 |
| Agent（Claude Code/Codex/Cherry Studio…） | 环境变量或配置里的 `mk_live_…` | MCP 或 OpenAI 兼容接口 | 花钱，受策略约束 |
| 卖方 | 无需注册 MoneySwitch | x402 | 收 USDC |

**不新增后端多用户体系**：员工视图只用现有 MoneyKey 可访问的接口（`/v1/status`、`/v1/history`、`/v1/models`、`/v1/chat/completions`、`/v1/dashboard/billing/*`）。

## A. Dashboard 员工视图（只改 apps/dashboard/）

1. 登录页单输入框自动识别：`ms_admin_` 前缀 → 管理员控制台（现状）；`mk_live_` 前缀 → **员工视图**。token 都只存 sessionStorage，分别用不同的 storage key。登录框下方小字说明两种 key 的区别。
2. 员工视图侧边栏：**My Budget / Playground / History / Connect**（无 Keys、Channels、Wallet、Approvals）。顶栏显示 Key 名称（若 `/v1/status` 无名称则显示前缀 `mk_live_ab12••••`）、网络徽章。
3. My Budget：大号「今日剩余 $0.29 / $0.30」环形或进度条、总额度进度、单笔上限、可用模型（`/v1/models`）、最近 5 笔。额度 >80% 橙色提示「接近今日上限，请联系管理员」。
4. History：`/v1/history` 表格（时间、类型、模型/URL、金额、状态、tx 链接），与管理员 Usage 同风格。
5. Playground：复用现有 Playground 组件，key 自动使用当前登录的 MoneyKey（不再让员工二次粘贴）。
6. Connect：展示给本机 Agent 接入的三种方式——① 一键命令 `npx moneyswitch-connect --server <当前 origin> --key <当前 key>`（复制按钮，key 以掩码显示、复制时带完整值）② OpenAI 客户端 Base URL + Key ③ 手动 MCP 命令。
7. 管理员侧 MoneyKeys 创建成功页新增 tab **「Send to employee」**：一段可直接粘贴到企业微信/飞书的中文说明（服务器地址、Key、登录员工视图的地址、一键命令），复制按钮。
8. 若 `/v1/status` 当前不返回 key 名称：记录为需后端补字段（见 B.0），前端先回退显示前缀。

## B. 桌面一键接入 CLI（新包 apps/connect，Apache-2.0）

0. 后端小改：`GET /v1/status` 追加 `key_name`、`key_prefix`、`daily_budget`、`total_budget`（不含任何秘密）。补测试。
1. 包名 `moneyswitch-connect`，bin `moneyswitch-connect`，纯 Node 22+，零或极少依赖。遵循 AI-friendly CLI：非 TTY 或 `--json` 时 stdout 只输出 JSON，日志走 stderr，退出码 0 成功 / 1 失败 / 2 参数错。
2. 命令：
   - `moneyswitch-connect --server <url> --key <mk_live_…> [--apply] [--json]`：
     1) 调 `GET <server>/v1/status` 验证 key，打印 Key 名、今日剩余、网络；失败直接退出 1。
     2) 探测本机 Agent：Claude Code（`claude` 在 PATH）、Codex（`codex` 在 PATH 或 `~/.codex/` 存在）、Cherry Studio / Open WebUI（只输出手填说明，不改它们的配置）。
     3) 默认 **dry-run**：列出将要做的改动；加 `--apply` 才执行：Claude Code → `claude mcp add moneyswitch -s user -e MONEY_API_BASE=… -e MONEY_API_KEY=… -- node <本包内置 mcp 入口的绝对路径>`（已存在同名则先 `claude mcp remove moneyswitch -s user`）；Codex → 在 `~/.codex/config.toml` 追加/替换 `[mcp_servers.moneyswitch]` 段（写前备份为 `config.toml.bak-<时间戳>`，只动这一段）。
     4) 打印总结：哪些 Agent 已接入、如何撤销。
   - `moneyswitch-connect status --server --key`：只查额度。
   - `moneyswitch-connect remove [--apply]`：移除上面加的配置。
3. MCP 入口：直接依赖/复用 workspace 内 `apps/mcp` 的构建产物（不要复制代码）；如果做成独立 npm 包需要打包，v0.3-lite 只要求在本仓库内 `node apps/connect/dist/index.js` 可运行，`npx` 发布留到以后，文档如实写。
4. 测试：用临时 HOME（设置 `HOME`/`USERPROFILE` 与 `CODEX_HOME`）验证 Codex 配置写入/备份/替换/移除；Claude Code 部分用可注入的命令执行器做单测（不要真的改本机 Claude 配置）；status 用 echo 实例或 mock server。

## 验收（主会话做模拟）

- 管理员：登录 → 给「张三 · Claude Code」开 Key → 复制「Send to employee」说明。
- 员工：用 mk_live_ 登录 → 看到自己额度 → Playground 发消息扣费 → History 出现链上 tx → 复制一键命令。
- 桌面：在临时 HOME 下跑 connect dry-run 与 --apply，配置正确写入；status 返回余额。
- Agent：Claude Code 通过 MCP 付费一次；openai SDK 通过网关付费一次。
- 卖方：demo-seller 日志出现结算，链上 Transfer 可核对。
