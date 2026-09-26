# MoneySwitch v0.5 — 收费站：让任何 API 向 AI 收 USDC（增量规格，冲突时以本文件为准）

## 0. 一句话
在 MoneySwitch 里点几下，就能在你已有的 API 前面立一个「收费站」：AI 付了 x402 USDC 才放行，钱直接进你的收款地址，Dashboard 像看营收一样看收入。**卖家不需要任何秘密，只需要一个公开的收款地址；你的服务一行代码都不用改。**

## 1. 三样东西的心智模型（贯穿全部 UI 与文档，这是本版本的第一优先级）
| 东西 | 比喻 | 给谁 | UI 规范 |
|---|---|---|---|
| 私钥 | 保险柜钥匙 | 谁都不给，UI 永不显示 | 不出现；文档里说明「它只在服务器内存里」 |
| MoneyKey `mk_live_` | 给员工的限额副卡 | 只给**自己的** AI | 🔒 琥珀色 + 锁图标 +「保密：拿到它的人能在额度内花你的钱，不要发给卖家」 |
| 收款地址 `0x…` | 收款码 | 可以给**任何人** | ✅ 绿色 + 分享图标 +「公开：别人付钱给你用它，可以放心分享」 |

- 新增一张「三样东西」解释卡（钱包页、收费站页、登录页帮助里都可打开），配简单插画或图标。
- **防呆**：任何「收款地址」输入框粘贴 `mk_live_`/`ms_admin_`/64 位 hex（疑似私钥）→ 拦截并解释；任何 Key 输入框粘贴 `0x` 地址 → 拦截并解释。服务端同样校验（`INVALID_PAY_TO` 等）。
- 收款地址必须是合法 EVM 地址（EIP-55 校验和，全小写也接受但显示时转校验和格式）；**默认 = 本 MoneySwitch 钱包地址**（钱包收付一体），可改为任意外部地址（如冷钱包），改为外部地址时提示「钱将进入这个地址，MoneySwitch 无法替你花」。

## 2. 收费站（服务端，apps/server + packages/*）
### 数据
- `tollbooths`：id, name, slug（URL 安全、唯一）, upstream_url（http/https）, pay_to, network, enabled, forward_host_header(bool,默认 false), created_at。
- `tollbooth_routes`：id, tollbooth_id, method（GET/POST/…/ANY）, path_pattern（前缀或 `*` 通配，精确规则见实现，按最长前缀优先）, price（micro-USDC，0 = 免费放行）, description。未匹配任何规则的请求 → 默认规则（收费站级 `default_price`，可为「拒绝」）。
- `earnings`：id, tollbooth_id, route_id, method, path, amount, payer（付款地址）, tx_hash, network, status（settled/failed）, upstream_status, created_at。
- 新 migration，不改旧 migration。

### 对外入口
- `ANY /t/{slug}/*` → 收费站代理。流程：
  1. 查收费站（enabled）与匹配路由；价格 0 → 直接转发。
  2. 使用 **x402 官方服务端 SDK**（`@x402/core/server` 的 `x402ResourceServer` + `HTTPFacilitatorClient` + `@x402/evm` ExactEvmScheme，测试网 USDC 用 registerMoneyParser，参照 apps/demo-seller 现有写法；若用 `@x402/core/http` 的框架无关 HTTP 服务端 + Fastify 适配最合适就用它；**禁止自写 402/EIP-712**）：无付款 → 402（含 payTo=收费站 pay_to、价格、资源描述）；有付款 → verify。
  3. verify 通过 → 转发到 upstream（`redirect:"manual"`、超时 30s、响应上限 10MB，剥离 hop-by-hop 与 x402 付款头，**不转发**买家的 Authorization；附加 `X-MoneySwitch-Payer`、`X-MoneySwitch-Amount`、`X-MoneySwitch-Tollbooth` 给上游）。
  4. **只有上游返回 2xx/3xx 才 settle**（上游 4xx/5xx → 不结算、买家不被扣钱，earnings 记 failed + upstream_status）。这是对买家的保护，写进文档和 UI。
  5. settle 成功 → 在响应上加 x402 结算头（SDK 做），记 earnings。
- 上游地址安全：由管理员配置，允许内网/本机（卖家常把自己本机服务挂上去），但**禁止指向 MoneySwitch 自身端口/本机管理接口**（复用 SSRF 自身端口规则）。
- 同一 MoneySwitch 的 MoneyKey 买自家收费站：允许（常见于演示）。

### 管理 API（admin token）
- `GET/POST /v1/admin/tollbooths`，`PATCH/DELETE /v1/admin/tollbooths/:id`，路由增删改，`POST /v1/admin/tollbooths/:id/test`（免费探测 upstream 是否可达，不收费）。
- `GET /v1/admin/earnings?tollbooth=&range=today|7d|all`（含合计）。
- `GET /v1/admin/meta` 追加 `wallet_address`（作为默认收款地址）与收费站公网基址（请求 origin）。

## 3. Dashboard
- 侧边栏新增「收费站 / Toll booths」与「收入 / Earnings」（可合为一组「收款」）。
- 新建收费站向导（3 步，句式化）：① 「把哪个服务挂出去？」upstream URL +「测试连接」② 「怎么收费？」路由列表（预设模板：「整个服务每次 $0.01」「/v1/chat/completions 每次 $0.01，其余免费」…）③ 「钱进哪里？」收款地址（默认本钱包，绿色公开样式 + 解释卡链接）。完成页给出：公开调用地址 `https://<server>/t/<slug>/…`、买家怎么调（curl 看 402、MoneySwitch paid_fetch、OpenAI 兼容上游可作为别人 MoneySwitch 的「渠道」）、复制按钮。
- 收入页：今日/7 天/全部合计、按收费站与路由分组、每笔（时间、付款地址短码、路由、金额、tx 链接、上游状态），CSV 导出。Overview 增加「今日收入」KPI（与「今日支出」并列）。
- 钱包页：顶部分成「收款」（地址 + 二维码 + 公开说明）与「付款来源」两栏，体现「一个钱包，收付一体」。
- 所有文案中英双语（沿用 i18n 结构）；「三样东西」解释卡与防呆提示全覆盖。

## 4. `moneyswitch sell`（apps/cli，Apache-2.0，可选但推荐）
- `moneyswitch sell --upstream http://localhost:8000 --price 0.01 --pay-to 0x… [--route "POST /v1/chat/completions=0.01" …] [--port 4402] [--network testnet]`：不需要 MoneySwitch 服务器，单进程本机收费站，用 `@x402/express` 或 `@x402/hono`（官方）。启动时打印公开地址与收款地址（绿色、公开），拒绝把 `mk_live_`/私钥当 `--pay-to`。
- 与服务端收费站共享路由匹配与转发逻辑（放在可复用模块里，不复制两份）。

## 5. 测试（离线必须全绿）
- 单测：路由匹配（最长前缀、方法、通配、默认价/拒绝）、pay_to 校验（校验和、拒绝 mk_live/私钥形状）、转发头处理（剥离 Authorization、x402 头，附加 X-MoneySwitch-*）、上游 SSRF 自身端口拒绝。
- e2e（mock-facilitator + 一个本地假上游）：未付 → 402（payTo 正确）；MoneySwitch MoneyKey 通过 /v1/fetch 购买收费站 → 上游收到请求与 X-MoneySwitch-Payer、earnings +1、买家 usage +1；上游 500 → 买家未被扣款（payments 无 settled、earnings failed）；价格 0 路由免费放行；禁用收费站 → 404；`moneyswitch sell` 同样的 402→付款→放行链路。
- 全仓库 build/test/test:e2e 绿。

## 6. 不做
退款、发票、订阅/包月、按 token 计价（upto）、多币种、法币。
