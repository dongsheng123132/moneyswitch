# 4 个云端任务（用 Claude Code 云端额度）

**用法**：打开 https://claude.ai/code → 新建会话 → 仓库选 `dongsheng123132/moneyswitch` → 把下面某一节「任务说明」整段粘进去发送。每个任务开一个单独的会话，4 个可以同时跑。每个会话做完会开一个 **draft PR**，不会自动合并，你看过再合。

这 4 个任务改的文件互不重叠，也避开了本地正在改的代理相关文件（`apps/server/src/index.ts`、`apps/cli` 的入口、根目录 README）。

---

## 任务 1：付款客户端更稳（超时与 JSON 头）

MoneySwitch 是「给 AI 一把有额度的钱」：AI 拿 MoneyKey（mk_live_），通过本地服务端用 x402 在 Monad 上付 USDC。先读 README.md、SPEC.md、SPEC-v0.5.md。

任务：提升 x402 买家客户端的稳健性。只改 packages/x402 及其测试；不要改 apps/server/src/index.ts、apps/cli 的入口文件和根 README，另一个会话在改这些。

1. packages/x402/src/client.ts 里的上游请求超时现在写死 30 秒（约第 100 行）。改成可配置：
   - 环境变量 MONEYSWITCH_UPSTREAM_TIMEOUT_MS，默认 60000；
   - 调用参数里可以传可选的 timeoutMs 覆盖，上限 180000。

   原因：有的卖家要调 LLM 解读，处理要 25 秒左右，再加上结算时间，30 秒会出现「钱付了，结果没拿到」。
2. 同一文件约第 247–251 行，body 是对象时没有自动加 Content-Type。改成：
   - 对象或数组：自动 JSON.stringify；调用方没显式指定时，加上 content-type: application/json；
   - 字符串或 Buffer：保持原样。
3. 为这两处加离线单元测试，沿用仓库现有的测试框架和 mock facilitator；原有测试必须全部通过。
4. 在根目录 CHANGELOG.md 记一条。

流程：
- 从 main 建分支 cloud/x402-client-timeout；
- 跑 pnpm install && pnpm build && pnpm test，全绿后再提交；
- push，开一个 draft PR。标题用中文；正文写改了什么、为什么改、测试输出末尾、对调用方有没有兼容性影响。
- 不要合并，不要提交任何密钥。

---

## 任务 2：key 可以直接改，不用重发

MoneySwitch 是「给 AI 一把有额度的钱」。先读 README.md、SPEC.md、SPEC-v0.4.md（子 key 层级）、SPEC-v0.5.md。MoneyKey 带这几项设置：总额、日额、单笔上限、审批阈值、allowed_hosts；子 key 受父 key 约束。

现在的问题：
- key 发出去之后改不了。apps/server/src/routes/admin.ts 里只有创建和撤销。想让 AI 多访问一个服务，只能重发一把 key，再把 agent 重新配一遍。
- allowed_hosts 只做精确匹配（packages/core/src/gate.ts 约第 24 行）。

任务：
1. **服务端**：
   - 新增 PATCH /v1/keys/:id（需要 admin 权限），可以修改 name、total_budget、daily_budget、per_request_limit、approval_threshold、allowed_hosts、max_payments_per_minute、expires_at、allowed_models。
   - 校验规则和创建时一致；额度不能调到低于已经花掉的金额；每次修改都要写审计日志（writeAudit）。
   - 子 key：父 key 持有者可以通过 apps/server/src/routes/children.ts PATCH 自己的子 key，但不能超出父 key 的额度约束，沿用 v0.4 的祖先链校验。
2. **通配符**：allowed_hosts 支持「*.example.com」写法。它匹配任意一级或多级子域，但不匹配 example.com 本身；端口规则和现有的精确匹配保持一致。要加单测覆盖边界情况。
3. **Dashboard**：MoneyKeysPage 和员工视图的子 key 页各加一个「编辑」表单（复用创建表单的组件），并补上中英文文案。
4. **离线测试**：PATCH 的正反用例都要覆盖，包括越权修改、超出父 key 额度、非法值、审计记录是否写入。原有测试全部通过。

约束：
- 不要改 apps/server/src/index.ts、apps/cli 的入口文件、根目录 README。
- 不要提交任何密钥。

流程：
- 从 main 建分支 cloud/editable-keys。
- 跑 pnpm install && pnpm build && pnpm test，全绿后再提交。
- push，开 draft PR，不要合并。PR 标题用中文，正文写清楚：动机、接口定义、安全考虑、测试输出的末尾。

---

## 任务 3：让 AI 自己发现服务、查审批进度（MCP）

先读 README.md、SPEC.md、docs/CLAUDE.md、apps/mcp/src/index.ts。现在 MCP 只有三个工具：money_status、paid_fetch、money_history。

1. **新增 MCP 工具 `discover({ query, max_price_usdc?, limit? })`**
   - 先查可选的服务索引：环境变量 MONEYSWITCH_INDEX_URL 指向一个 services.json。它是一个数组，每项形如 {name,url,method,price_usdc,networks[],category,desc}。按 query 做不区分大小写的子串匹配。
   - 再查 Coinbase Bazaar 的公开发现接口：`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=<q>&network=<当前网络>&maxUsdPrice=<max>`。
     - 不需要 key。
     - 当前网络从本地 server 的 /v1/status 里 network 字段取，例如 eip155:143。
     - limit 最多 20。
   - 两个来源的结果按 URL 合并去重。返回一份简洁列表：名称、URL、方法、价格、网络、来源（index 或 bazaar）。末尾提示「用 paid_fetch 调用，受 MoneyKey 额度约束」。
   - 任一来源失败时降级：只返回能拿到的结果，并说明哪个来源失败了。
2. **新增 MCP 工具 `approval_status({ approval_id })`**
   - 返回审批状态（pending / approved / denied / expired）、金额和 URL。
   - 如果服务端没有从 key 这一侧查询审批的接口，就新增一个只读路由，放在新文件 apps/server/src/routes/approvals-agent.ts 里，并在路由注册处加一行。
   - 只允许发起该审批的 MoneyKey 查询自己的审批。
3. **改 paid_fetch 的提示文案**：需要审批时，告诉 AI 可以用 approval_status 轮询，批准后带同一个 approval_id 重试。
4. **离线测试**，原有测试必须全部通过：
   - discover：mock fetch，覆盖索引命中、Bazaar 命中、两源合并去重、一个来源失败时降级；
   - approval_status：正反用例都要有，查别人的审批必须被拒。
5. **文档**：在 docs/CLAUDE.md 里补上这两个新工具的说明。

约束：
- 不要改 apps/server/src/index.ts、apps/cli 的入口文件、根 README。
- apps/server/src/routes/agent.ts 除了第 2 条必需的那一行路由注册，其他不要动。

流程：
- 从 main 建分支 cloud/mcp-discover-approvals。
- 跑 pnpm install && pnpm build && pnpm test，全绿后提交。
- push 并开 draft PR，不要合并。

---

## 任务 4：CC Switch 式审批体验 + 付款凭证

先读 README.md、SPEC.md、SPEC-v0.4.md、SPEC-v0.5.md、apps/server/src/routes/agent.ts 和 apps/dashboard。

MoneySwitch 是本地运行的「AI 钱包」，定位类似 Clash Verge、CC Switch 这类本地工具。现在的审批流程是：付款超过审批阈值时，接口返回一个 approval_id；人要去 Dashboard 点批准，AI 还得自己重新发起请求。体验很差。

**A. 审批**

1. /v1/fetch 支持可选参数 wait_for_approval_seconds，默认 0，上限 120；MCP 的 paid_fetch 把这个参数原样透传过去。
   - 当付款需要审批、且这个参数大于 0 时：创建审批后先挂起请求，等待审批结果。
   - 批准：继续完成付款，返回正常结果。
   - 拒绝或超时：返回明确的状态和 approval_id。超时后仍然可以用原来的方式重试。
   - 预算的占用和释放要和现有的 held / unknown 机制一致；多个请求并发时不能重复扣额度。
2. Dashboard 在任何页面都能收到「待审批」提醒：
   - 提醒形式：页面顶部 toast、浏览器 Notification API（第一次使用时请求授权）、一声轻提示音。
   - toast 上直接放「批准」和「拒绝」按钮。
   - toast 里显示：哪个 key（也就是哪个 AI）、要花多少钱、付给哪个 URL 或收款地址。
   - 文案要有中英文两版（i18n）。

**B. 付款凭证**

3. 以下三处返回的每一笔付款，都加上三个字段：
   - 返回位置：/v1/fetch 的成功返回、/v1/history、MCP 的 money_history。
   - explorer_url：用当前网络的 explorerBase 拼上 /tx/<hash>。
   - pay_to：收款地址。
   - description：取卖家 402 响应里的 resource.description（有才加）。
4. 修复员工视图里的 TxLink。它依赖 meta，而 meta 只有管理员能读，所以员工登录时，主网交易会链接到测试网浏览器。改成从 key 可读的 /v1/status 取浏览器地址，也可以在里面新增一个 explorer_base 字段。

**C. 离线测试**

5. 覆盖以下场景，原有测试必须全部通过：
   - wait_for_approval 的四种情况：批准、拒绝、超时、并发；
   - explorer_url 的拼接；
   - 员工视图下 TxLink 链到正确的网络。

**约束**

- 不要改 apps/server/src/index.ts、apps/cli 的入口文件、根目录 README。
- 不要新增 MCP 的 discover / approval_status 工具，这是任务 3 的内容。

**流程**

- 从 main 建分支 cloud/approval-wait-receipts。
- 跑 pnpm install && pnpm build && pnpm test，全部通过后提交。
- push，开 draft PR。PR 正文写清楚：交互怎么走；为什么并发下预算是安全的；测试输出的末尾几行。
- 不要合并。
