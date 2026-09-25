# MoneySwitch 体验审计（ux-audit）

- 日期：2026-09-26
- 走查环境：独立实例（server :18020 / demo-seller :18021 / mock-facilitator :18099），数据目录 `.data/ux/before-data`，
  Playwright 1440×900 暗色，截图 `.data/ux/before/`（改后对应截图 `.data/ux/after/`）。
- 走查方式：按 4 个角色真实操作一遍（管理员首装、员工、Agent 开发者、管理员日常），每步截图 + 抓页面文字。
- 严重度：**P0** = 按界面走会失败 / 做不下去；**P1** = 能走通，但需要翻文档、翻日志或靠猜；**P2** = 打磨项。

> 走查附带记录：界面「Prefill: Demo LLM」默认的 `http://127.0.0.1:4021/v1` 让我在走查中点「Fetch models」时，
> 对本机正在运行的真实实例 :4021 发了一次只读 `GET /v1/models`（没有付款、没有写入）。这正是下面 A-7 的问题本身。

---

## 角色 1：首次安装的个人用户 / 公司管理员

| # | 步骤 | 问题 | 严重度 | 改法 |
|---|---|---|---|---|
| A-1 | 启动后打开 Dashboard | 登录页只让「粘贴 ms_admin_ token」，但 token 只在**首次启动**时打印到 stdout/日志一次。`pnpm demo:local` 用户要自己去 `.data/local/server.log` 里 grep；服务重启过就再也不打印。登录页没有任何「token 在哪」的提示。 | P0 | 首次启动额外打印一条**一次性 setup 链接**（`http://127.0.0.1:4020/setup#ms_setup_…`），点开即登录并进入引导；登录页检测到「首次运行链接仍有效」时直接提示去终端找链接；丢 token 时给出 `pnpm admin:reset-token` 的原命令。安全取舍见文末「威胁分析」。 |
| A-2 | 登录后 Overview | 全新实例的 Overview 是一排 0 和「No MoneyKeys yet」，不告诉用户接下来要：建钱包 → 充 USDC → 加渠道 → 发 Key → 接 Agent。 | P0 | 新增分步引导 `/setup`（5 步，每步自动检测完成、可跳过），Overview 顶部在未完成时显示「开始使用」清单卡片。 |
| A-3 | Wallet → 创建钱包 | 创建成功后「How to fund」写着 *request test MON for gas*，与 README 事实矛盾（Agent 金库不需要 gas，facilitator 代付）；没有水龙头链接，不知道要充**哪种** USDC、充多少、多久到账。 | P1 | 改为：只需要 Monad 测试网 USDC、不需要 MON；给 Circle 水龙头直达链接 + 选网络步骤；余额每 3 秒自动刷新，到账后打勾；说明 mock 模式（demo:local）不需要真余额，可跳过。 |
| A-4 | Wallet → 密码 | 没说明钱包密码的作用：重启后钱包会**锁住**，需要再解锁或设 `MONEYSWITCH_WALLET_PASSWORD`；锁住时所有付款报 `WALLET_LOCKED`，用户只能猜。 | P1 | 创建表单下写清楚「重启后需要用这个密码解锁」；锁住时在顶栏/Overview 显示「钱包已锁定 → 去解锁」。 |
| A-5 | 任意页 | 首屏 Overview 要等 `/v1/admin/wallet`（服务端查链上余额，实测约 2 s）才渲染，期间整页骨架屏；链上 RPC 慢/不通时 Overview 一直是空的。 | P1 | Overview 的 Key/流水数据与钱包余额分开加载，余额慢不阻塞主体。 |
| A-6 | Channels → Add channel | 「渠道」是什么、为什么需要，页面上没有解释；x402 / facilitator 等术语无解释。 | P1 | 空状态写明「渠道 = 按次收费的 OpenAI 兼容上游；Agent 对话时 MoneySwitch 用 x402 付钱给它」，并提供「一键添加 demo 渠道」；术语加悬停解释。 |
| A-7 | Channels → Prefill demo | demo 预填写死 `127.0.0.1:4021`。本机同时跑两个实例（或 demo-seller 换了端口）时，会**静默接到另一个实例的卖方**，点 Fetch models 还「成功」了。 | P1 | 服务端通过 `MONEYSWITCH_DEMO_SELLER_URL`（demo 脚本自动设置）告诉 Dashboard 正确的 demo 卖方地址；没有配置时预填但标明「请确认端口」。 |
| A-8 | Money Keys → Create | 表单是一堆裸字段：Daily budget / Total budget / Per-request limit / Approval threshold / Max payments / Allowed hosts / Expires at (ISO)。用户不知道哪个会拦、哪个会进审批、`allowed hosts` 对对话是否生效（实际：对话走渠道自动放行，只对 paid_fetch 生效）、ISO 日期怎么写。 | P1 | 改成句式：「这个 Agent **每天最多花 $__**，**单次最多 $__**，**超过 $__ 要我批准**，总共最多 $__」；实时预览「按 $0.01/次 约可调用 N 次/天」；allowed hosts 默认从已启用渠道推导并说明作用；过期时间用日期选择器；其余放进「高级」。 |
| A-9 | Money Keys → Create | 不点预设时 allowed hosts 默认是写死的 `127.0.0.1:4021`，与实际渠道无关。 | P1 | 默认值从渠道推导（同 A-8）。 |
| A-10 | Key 创建成功 → Claude Code 标签 | 命令是 `claude mcp add … -- node C:/1mineyswitch/apps/mcp/dist/index.js`：①路径写死成作者机器上的路径；②缺 `-s user`，默认只对当前目录生效，换个目录开 Claude Code 就看不到。 | P0 | 所有接入命令集中生成：优先用 `moneyswitch connect`（自动探测 Claude Code/Codex、先 dry-run），手动命令带 `-s user`，MCP 入口用本服务器分发的 CLI 包或本机真实路径（服务端告诉前端）。 |
| A-11 | Key 创建成功 / 员工接入页 | 「一键接入」命令是 `npx moneyswitch-connect …`；README 写的是 `npx moneyswitch connect …`。**两个包都不在 npm 上**（`npm view moneyswitch` → 404，实测 `npx -y moneyswitch-connect` → E404）。照界面复制粘贴一定失败。 | P0 | 服务端把已构建的 CLI（`apps/cli`，Apache-2.0，自包含 2 个文件）打成 tarball，在 `GET /dl/moneyswitch.tgz` 提供下载；命令改为 `npx -y --package=<服务器>/dl/moneyswitch.tgz moneyswitch connect …`，任何装了 Node 的机器可用，不依赖 npm 发布。 |
| A-12 | Connect Agent 页 | 页面上所有代码片段写死 `http://127.0.0.1:4020` 和 `C:/1mineyswitch/...`，与当前访问地址无关；也没有 REST（`/v1/fetch`）示例。 | P0 | 用当前 origin 和真实 CLI 来源生成；按「桌面 Agent（MCP）/ OpenAI SDK / REST」分组。 |
| A-13 | 全局 | 管理员控制台全英文，员工视图全中文，登录页中英混排；没有语言切换。 | P1 | 统一 i18n：默认跟随浏览器语言，右上角切换并记住；文案集中在 `src/i18n/`。 |

## 角色 2：员工

| # | 步骤 | 问题 | 严重度 | 改法 |
|---|---|---|---|---|
| B-1 | 收到管理员消息 | 「发给员工」模板里的一键命令是 `npx moneyswitch-connect`（不存在，同 A-11）。 | P0 | 同 A-11。模板改为：登录地址、Key、一键命令、不装任何东西的 OpenAI 方式。 |
| B-2 | 接入页 ③ 手动 MCP | 命令路径写死 `C:/1mineyswitch/apps/mcp/dist/index.js`，员工机器上不存在；缺 `-s user`。 | P0 | 同 A-10。 |
| B-3 | 对话 → 超过审批阈值 | 员工看到 `APPROVAL_REQUIRED: Payment requires manual approval`，不知道要等谁、批完怎么继续；管理员批准后，员工那边没有「重试」入口（需要带 `approval_id` 重发）。 | P1 | 对话里显示「已提交给管理员审批（编号…）」+「管理员批准后点这里继续」按钮，自动带 approval_id 重发；管理员 Playground 同理。 |
| B-4 | 流水 / 我的额度 | 状态直接显示 `settled / reserved / unknown`；`unknown` 为什么也扣额度没有解释；`MOCK` 徽标无解释。 | P1 | 状态本地化（已结算 / 处理中 / 失败 / 待核对）并悬停解释；MOCK 悬停说明「离线模拟结算，没有链上交易」。 |
| B-5 | 我的额度 | 「单笔上限」「总额度」无解释；接近上限只在 ≥80% 提示；额度耗尽后没有明确说明「今天不能再用、明天 UTC 0 点恢复」。 | P2 | 术语悬停；耗尽时红色提示 + 恢复时间。 |
| B-6 | 登录 | Key 错误/被撤销时提示是英文原文（`MoneyKey has been revoked`）。 | P2 | 映射为本地化文案。 |

## 角色 3：Agent 开发者

| # | 步骤 | 问题 | 严重度 | 改法 |
|---|---|---|---|---|
| C-1 | 找 OpenAI SDK 代码 | 只有在**创建 Key 的那一刻**的抽屉里才看得到 Python/Node/curl 示例；关掉抽屉后，Connect Agent 页面只有写死地址的 MCP 片段，没有 SDK 示例。 | P1 | Connect Agent 页常驻「OpenAI SDK / REST / MCP」代码，Key 位置用占位符并提示粘贴；示例里的模型名取自当前已启用渠道。 |
| C-2 | REST `/v1/fetch` | 界面上完全没有 `/v1/fetch` 的示例和返回结构说明，需要看 `docs/money-api-v0.md`。 | P1 | 加 curl 示例 + 返回 `status/code/payment/approval_id` 说明。 |
| C-3 | MCP | 同 A-10/A-12，路径写死。 | P0 | 同上。 |
| C-4 | 验证 | 实测：界面给出的 Node openai SDK 片段在 18020 上能跑通（mock 结算，返回 `moneyswitch.tx_hash`）；`/v1/fetch` curl 能跑通。 | — | 保持。 |

## 角色 4：管理员日常

| # | 步骤 | 问题 | 严重度 | 改法 |
|---|---|---|---|---|
| D-1 | 看今天谁花了多少 | Overview 的 Agents 列表按创建顺序排列，不按今天花费；点 Agent 没有反应，不能跳到它的流水。 | P1 | 按今日花费排序；点击跳到 Usage 并按该 Agent 过滤。 |
| D-2 | 需要处理的事 | 待审批只在侧边栏有个小角标；钱包锁定/余额低没有任何提示。 | P1 | Overview 顶部「需要处理」条：待审批 N 条、钱包锁定、余额不足。 |
| D-3 | 处理审批 | 对话类审批卡片显示的是上游 URL（`…/v1/chat/completions`），看不出是哪个模型、该 Key 今天已经花了多少。 | P2 | 显示 Agent、金额、目标（模型/URL）、该 Key 今日已用/日预算。 |
| D-4 | 查某笔链上交易 | Usage 不能按 tx hash / URL / 模型搜索；筛选状态不在 URL 里，无法把「某 Agent 今天的流水」链接发给同事；没有「今天」时间范围；tx 只显示前 10 位且不能复制。 | P1 | 搜索框（tx/URL/模型）；筛选同步到 URL query；加「今天」；tx 链接 + 复制按钮，MOCK 行说明无链上交易。 |
| D-5 | 撤销 Key | 用浏览器原生 `confirm()`，英文，且不说后果（Agent 立即 401、不可恢复）。 | P2 | 行内二次确认，写清后果。 |
| D-6 | Playground | 管理员 Playground 要求粘贴 Key 全文，但 Key 只在创建时显示一次；创建完没有「在 Playground 里试试」。 | P2 | 创建成功页加「在 Playground 试一下」，把 Key 带过去（仅当前标签页 sessionStorage）。 |

## 跨角色 / 视觉

| # | 问题 | 严重度 | 改法 |
|---|---|---|---|
| X-1 | 术语无解释：per-request limit、approval threshold、allowed hosts、x402、facilitator、channel、unknown 状态。 | P1 | 统一的 `<Term>` 悬停/聚焦提示组件 + 集中词汇表。 |
| X-2 | 空状态只说「没有数据」，不说下一步。 | P1 | 每个空状态给出一句说明 + 主操作按钮。 |
| X-3 | 复制按钮只有「Copy/Copied」英文；抽屉无 Esc 关闭、无焦点管理。 | P2 | 本地化；抽屉支持 Esc、打开时聚焦首个输入。 |
| X-4 | 大量内联 style，卡片间距不一致（钱包页左右卡片顶端不齐）。 | P2 | 收敛成少量工具类；统一间距。 |

---

## 安全相关改动与威胁分析

### 1. 一次性 setup 链接（`/setup#ms_setup_…`）

**做法**
- 仅在数据目录**首次启动**、刚生成 admin token 的那一次，服务端在内存里再生成一个一次性 setup token（`ms_setup_` + 32 位随机 base62，约 190 bit），
  和 admin token 一起打印到 stdout：`http://127.0.0.1:<port>/setup#ms_setup_…`。原有的 admin token 打印保持不变（脚本和测试依赖它）。
- setup token **只存在进程内存**（存 SHA-256 哈希 + 待交付的 admin token），不落盘、不进数据库、不写日志。
- `POST /v1/setup/claim {setup_token}`：常量时间比对；成功则返回 admin token 并**立刻作废** setup token（单次）；
  30 分钟过期；累计 10 次错误尝试后作废；进程重启即作废。响应带 `Cache-Control: no-store`。请求体里的 `setup_token` 加入日志脱敏。
- `GET /v1/setup/status`（无需鉴权）只返回 `{ setup_link_active: boolean }`，供登录页决定是否提示「去终端找 setup 链接」。
- token 放在 URL **fragment**（`#` 之后）：浏览器不会把 fragment 发给服务器，也不会出现在 Referer / 访问日志里；前端读取后立即用 `history.replaceState` 抹掉。

**威胁分析**
| 威胁 | 结论 |
|---|---|
| 同机 Agent 直接调 `/v1/setup/claim` 拿 admin | 需要 setup token。token 只打印在服务端 stdout/日志——和 admin token 本身完全同一个信道。能读到这个日志的进程，改动之前就已经能读到 admin token，所以**没有扩大攻击面**。没有任何「来自 127.0.0.1 就放行」的逻辑。 |
| 同机 Agent 先读日志抢先 claim | 与读日志拿 admin token 等价（见上）；但抢先 claim 后，人再点链接会看到「链接已被使用」，**反而把入侵暴露出来**，而不是悄悄共用。 |
| 暴力猜 setup token | 190 bit 熵 + 10 次失败即作废 + 30 分钟过期。 |
| token 残留在浏览器历史 | 历史里只剩已作废的 setup token（单次、已使用）；admin token 本身只进 sessionStorage（与原登录方式一致）。 |
| `/v1/setup/status` 信息泄露 | 只暴露「当前是否有未使用的 setup 链接」一个布尔值，不暴露任何密钥、地址、数量。 |
| 重启后丢失链接 | 设计如此（不持久化 = 不会被离线读取）。登录页给出 `pnpm admin:reset-token` 原命令。 |

**明确不做的方案**：「本机回环访问免登录 / 首次回环访问自动领取 admin」。MoneySwitch 的 Agent 就跑在同一台机器上、访问的就是 127.0.0.1，
服务端无法区分「人的浏览器」和「Agent 的 curl」（Origin/Host 头都能伪造），这会让任何同机 Agent 绕过 admin 鉴权——违背产品的核心承诺，不采用。

### 2. `GET /dl/moneyswitch.tgz`（无需鉴权）
- 内容是 `apps/cli` 构建产物（Apache-2.0 客户端代码，与准备发布到 npm 的包内容相同），不含任何密钥或服务器配置；文件不存在时返回 JSON 404。
- 风险：若服务器被攻陷，攻击者可替换 tarball 让员工执行恶意代码——但服务器被攻陷时攻击者本就控制钱包与全部 Key；
  员工执行前能看到命令来源就是自己公司的服务器地址，这与「从公司内网装内部工具」的信任模型一致。界面同时提供不需要安装任何东西的 OpenAI Base URL 方式。

### 3. `GET /v1/admin/meta`（需要 admin token）
- 返回网络/USDC 合约/浏览器前缀/水龙头链接、demo 卖方地址（来自 `MONEYSWITCH_DEMO_SELLER_URL`）、本机 CLI 文件的绝对路径、是否通过环境变量自动解锁钱包（布尔值）。只对 admin 可见；不含任何密钥或密码。

### 4. `moneyswitch connect` 写入的 MCP 启动命令
- 仓库外运行时，CLI 会对 `--server` 指向的服务器发一次 `HEAD /dl/moneyswitch.tgz`，存在则把 MCP 启动命令写成从该服务器拉包。信任边界不变：`--server` 本来就是用户指定、MoneyKey 要发往的同一台服务器。

没有放宽任何现有鉴权：admin 路由仍只认 `ms_admin_`，Agent 路由仍只认 `mk_live_`。

---

## 走查中新发现的后端问题（已修）

| # | 角色 / 步骤 | 问题 | 严重度 | 改法 |
|---|---|---|---|---|
| B-3a | 员工 / 对话 → 审批 → 批准后重发 | 经 OpenAI 兼容网关的对话，批准后带 `approval_id` 重发**必然失败**：网关把 `approval_id` 原样转发进上游请求体，而审批绑定的是上游请求体的 sha256，重发时请求体变了 → `APPROVAL_INVALID`，且被映射成 HTTP 500。README 里「经人工审批的付款」走的是 `/v1/fetch`（`approval_id` 在请求体外），所以这条路径此前从未被测到。 | P0 | `apps/server/src/routes/gateway.ts`：`approval_id` 只作为 MoneySwitch 自己的字段读取，不转发给上游；`APPROVAL_INVALID` → 409、`WALLET_LOCKED` → 503，并给出人类可读说明。新增 e2e（`apps/server/test/e2e/gateway-flow.test.ts`「Gateway approval round-trip」）：409 → 管理员批准 → 重发 200 → 同一 approval 再用 409。已确认去掉修复后该用例失败。 |
| A-11a | 管理员首装 / 一键接入 | 即使 CLI 能从服务器下载，`connect --apply` 写进 Claude Code / Codex 的 MCP 启动命令仍是 `npx -y moneyswitch mcp`（npm 上不存在）→ Agent 里的 MCP 起不来。 | P0 | `apps/connect/src/lib/mcp-entry.ts` 新增 `resolvePortableMcpCommand`：仓库外运行时先 `HEAD <server>/dl/moneyswitch.tgz`，存在就写 `npx -y --package=<server>/dl/moneyswitch.tgz moneyswitch mcp`，否则才退回 npm 名。补单测。实测：临时 HOME 下 `--apply` 后，按写入的命令启动 MCP，`tools/list` 返回 3 个工具，`paid_fetch` 付款成功（mock）。 |

## 实现状态（第二步）

| 条目 | 状态 | 落点 |
|---|---|---|
| A-1 一次性 setup 链接 | 已做 | `packages/core/src/setup.ts`、`apps/server/src/{context.ts,routes/setup.ts}`、`scripts/demo-{local,testnet}.mjs`（终端直接打印链接）、`apps/dashboard/src/pages/{SetupPage,LoginPage}.tsx` |
| A-2 首次运行引导 | 已做 | `/setup` 5 步向导（自动检测、可跳过）+ Overview「开始使用」清单 + 侧边栏「设置向导」入口 |
| A-3/A-4 钱包充值与解锁引导 | 已做 | 向导第 2 步 + `WalletPage`（Circle 水龙头直达、无需 MON、余额 3 秒自动检测、锁定时置顶解锁） |
| A-5 Overview 不被余额查询阻塞 | 已做 | 钱包单独轮询 |
| A-6/A-7 渠道解释 + 一键 demo 渠道 | 已做 | `MONEYSWITCH_DEMO_SELLER_URL` + `GET /v1/admin/meta` + `addDemoChannel` |
| A-8/A-9 句式创建 Key + 实时预览 | 已做 | `MoneyKeysPage`、向导第 4 步 |
| A-10/A-11/A-12/B-1/B-2/C-3 接入命令 | 已做 | `apps/dashboard/src/snippets.ts` 统一生成；`GET /dl/moneyswitch.tgz`；`apps/cli/build.mjs` 生成 tarball |
| A-13 中英文切换 | 已做 | `src/i18n/`（默认跟随浏览器，右上角切换并记住；zh 文案类型检查必须覆盖全部 en key） |
| B-3 审批后继续 | 已做 | `PlaygroundChat`「继续」按钮带 approval_id 重发 + B-3a 后端修复 |
| B-4 状态本地化 + 解释 | 已做 | `StatusPill`、`TxLink`、glossary |
| B-5 额度耗尽/接近上限提示 | 已做 | `MyBudgetPage` |
| B-6 登录错误本地化 | 已做 | `auth.tsx` 返回错误码，`LoginPage` 映射 |
| C-1/C-2 常驻 SDK / REST 示例 | 已做 | `ConnectAgentPage` 三个分组，示例模型取自已启用渠道 |
| D-1 按今日花费排序 + 跳转流水 | 已做 | Overview → `/usage?key=…&range=today` |
| D-2 需要处理条 | 已做 | 待审批 / 钱包未建 / 锁定 / 余额为 0 |
| D-3 审批卡片上下文 | 已做 | Agent、金额、目标、该 Key 今日已用/阈值/单笔上限；最近已处理列表 |
| D-4 流水筛选与查 tx | 已做 | URL 同步筛选、「今天」、搜索 tx/URL/模型、tx 链接 + 复制 |
| D-5 撤销二次确认 | 已做 | 行内确认，写明后果 |
| D-6 创建后去 Playground 试 | 已做 | 「在 Playground 试一下」 |
| X-1/X-2 术语提示、空状态 | 已做 | `Term`、`EmptyState` |
| X-3 键盘可达性 | 部分 | 抽屉 Esc 关闭 + 焦点进出、`:focus-visible` 描边、跳到正文链接、提示可聚焦；**未做**抽屉内 Tab 焦点陷阱 |
| X-4 视觉统一 | 部分 | 新代码收敛到 `src/styles/*.css`；旧的内联样式未全部清理 |
