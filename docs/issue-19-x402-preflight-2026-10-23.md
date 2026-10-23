# Issue #19 复核：`/x402-testnet/check` 的 402 body 是否缺少 challenge

- 复核日期：2026-10-23（Asia/Shanghai）
- 对象：<https://app.moneyswitch.dev/x402-testnet/check>、[GitHub issue #19](https://github.com/dongsheng123132/moneyswitch/issues/19)
- 仓库基线：`main` = `a649d877`（2026-10-18，issue 仍 open；receiver 最后一次改动是 2026-10-03 的 `d6b8ddb`）

## 1. 结论

**现象仍然存在，但作为“产品缺陷”的告警不成立：这是外部检查器的误报。**

- 线上未付款请求今天仍是 `HTTP 402` + body `{}`（2 bytes）——与 issue 描述一致。
- 但完整的 challenge 一直在 **`PAYMENT-REQUIRED` 响应头**里：base64 编码的 x402 v2 `PaymentRequired`，含 `x402Version: 2`、`resource`、`accepts[0]`、`payTo`、`amount`、`network`。x402 v2 规范明确 header 是 HTTP 的 canonical 位置，body 属于实现细节。
- 检查器 `@eidonze/mcpreflight`（0.2.0 / 0.5.0）没有 base64 解码 `PAYMENT-REQUIRED`，把 body 的 `{}` 当成“payment document”，于是报 `NO_ACCEPTS`；它自己的 JSON 报告里同时写着 `headers.paymentRequired: true`，自相矛盾。
- 不是演示接口误用：该端点就是测试收款端点，未付款返回 402 报价是设计行为；健康检查是 `/healthz`（200）。
- 仍做了一个**最小防御性修复**：只让 demo receiver 的 402 body 镜像 header 中的同一 `PaymentRequired` 对象，方便只读 body 的检查器/工具；不触碰定价、验证、结算和 MoneySwitch 其他支付能力。

| 假设 | 判定 | 依据 |
| --- | --- | --- |
| 真实产品缺陷（challenge 缺失/支付链路坏） | **否** | header 完整且规范；MoneySwitch 自己的 payer 读的就是 header；既有 receiver 测试从 issue 之前就在断言 header |
| 演示接口误用（健康检查返回 402） | **否** | `/healthz` 返回 200；收费端点未付款返回 402 是报价 |
| 外部检查器误报 | **是（主因）** | `mcpreflight` 未解码 base64 header，把 `{}` body 当文档；报告自身记录 `headers.paymentRequired: true` |
| 文档/互操作小缺口 | **轻微存在（已修）** | 文档原先没写报价在 header；body-only 工具会误判 |

## 2. 现场证据（2026-10-23 16:2x +08，只读）

```
GET https://app.moneyswitch.dev/x402-testnet/check
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
Content-Length: 2
Payment-Required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcHAubW9uZXlzd2l0Y2guZGV2L3g0MDItdGVzdG5ldC9jaGVjayIsImRlc2NyaXB0aW9uIjoiTW9uYWQg5rWL6K+V572RIMK3IOavj+asoSAwLjAxIOa1i+ivlSBVU0RD77yI5peg55yf5a6e5Lu35YC877yJIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NToxMDE0MyIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDUzNGIyZjNBMjExMzBkN2E2MDgzMGMyRGY4NjIzMTllNTkzOTQzQTMiLCJwYXlUbyI6IjB4YzgxRmQ1OTJiQTdkRTVmNTY3NTM4YTlBZWEyNTNEODgzNjE4QjZFMiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX1dfQ==
body: {}
```

header 解码后（关键字段）：

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "https://app.moneyswitch.dev/x402-testnet/check", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:10143",
    "amount": "10000",
    "asset": "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    "payTo": "0xc81Fd592bA7dE5f567538a9Aea253D883618B6E2",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

也就是说 issue 要求的 `accepts`、`payTo`、challenge document 都在，只是不在 body。

## 3. 规范与实现依据

- x402 v2 规范 §5.1.1：PaymentRequired 对象由 transport 决定承载位置；**“For HTTP, the canonical wire location is the base64-encoded `PAYMENT-REQUIRED` response header.”**（[x402-specification-v2.md](https://raw.githubusercontent.com/x402-foundation/x402/main/specs/x402-specification-v2.md)）
- HTTP transport 规范：**“Response bodies are a server implementation concern. All x402 protocol information is communicated through headers”**，并且规范示例本身就是 `PAYMENT-REQUIRED: …` + body `{}`。（[transports-v2/http.md](https://raw.githubusercontent.com/x402-foundation/x402/main/specs/transports-v2/http.md)）
- 实现路径：`apps/demo-seller/receiver.mjs` 用 `@x402/express@2.27.0` 的 `paymentMiddleware`；该版本对 `payment-error` 先设置 headers，再 `res.json(response.body || {})`（`@x402/express` 2.27.0 `dist/esm/index.mjs`），所以未付款 402 的 body 就是 `{}`。
- MoneySwitch 买方读的也是 header：`packages/x402/src/client.ts` 明确提到 `@x402/fetch` 从 `PAYMENT-REQUIRED` header 继续支付；`apps/server/test/stub-seller.ts` 与 `apps/demo-seller/receiver.test.mjs` 都按 header 解析报价。**既有测试在 issue 之前就已断言 `accepts[0].payTo`，说明协议侧一直有覆盖。**

## 4. 误报根因（可直接给上游复现）

`@eidonze/mcpreflight@0.2.0`（issue 提交时最新）与 `0.5.0`（当前最新）的 `bin/mcpreflight.mjs` 中：

```js
const candidates = [headers['payment-required'], headers['x-payment-required'],
                    headers['www-authenticate'], body].filter(Boolean);
// 只做 JSON.parse 和截取 {...}，没有 Buffer.from(..., 'base64') 解码
```

对 MoneySwitch 的响应：

1. `payment-required` 候选是 base64 字符串，`JSON.parse` 失败、`indexOf('{')` 也找不到 `{`；
2. body `{}` 被 `json('{}')` 解析成对象，成为唯一 “document”；
3. `requirements({})` 返回空数组 → 报 `NO_ACCEPTS`。

同时报告 JSON 里 `headers.paymentRequired` 又是 `true`。复现结果（用真实 0.2.0 / 0.5.0 源码跑）：

| 目标 | inspector | HTTP | body | finalStatus | findings |
| --- | --- | --- | --- | --- | --- |
| 线上旧构建（现状） | 0.5.0 | 402 + header | 2 B | FAIL | `NO_ACCEPTS`（`headers.paymentRequired: true`） |
| 线上旧构建（现状） | 0.2.0 | 402 + header | 2 B | FAIL | `NO_ACCEPTS` |
| 本地修复后 receiver | 0.5.0 | 402 + header | 458 B | **PASS** | 无，解析出 1 个 accepts |
| 本地修复后 receiver | 0.2.0 | 402 + header | 458 B | **PASS** | 无 |

另有两处上游问题可一并反馈：`requirements()` 注释里把 v2 canonical 形状写成 `{ x402: { version, accepts } }`，真实 v2 是 `{ x402Version, resource, accepts }`；以及不应把空 `{}` body 当作“已解析到 payment document”。

## 5. 最小修复（本次改动）

只改 demo receiver 的 402 响应，不碰支付逻辑：

1. `apps/demo-seller/receiver.mjs`：在 `paymentMiddleware` 之前加一个 12 行中间件，包装 `res.json`；仅当 `statusCode === 402` 且响应存在 `payment-required` header 时，把 header 解码后的 `PaymentRequired` 合并进 JSON body。header 仍是权威来源；解析失败则保持 SDK 原 body。
2. `apps/demo-seller/receiver.test.mjs`：新增断言——未付款 402 的 body 必须与 header 解码头对象 `deepEqual`；无效签名 402 的 body 也带正确 `payTo`。
3. `docs/x402-receiver.md`：写明报价在 `PAYMENT-REQUIRED` header、body 为镜像、如何复验；`CHANGELOG.md` 增加 `Unreleased — 2026-10-23` 条目。

为什么这不是“扩大范围”：改动仅存在于测试收款端点；`/v1/fetch`、预算、审批、回执、网络选择、SDK 版本均未变。body 镜像也不违反规范——规范把 body 明确留给实现。

## 6. 回归验证路径

已执行（本地，2026-10-23）：

```powershell
node --test apps/demo-seller/receiver.test.mjs
# 5 passed, 0 failed（含新增 body==header 断言）

node tmp/issue19-inproc.mjs        # mock facilitator 起本地 receiver，跑真实的 mcpreflight 0.2.0/0.5.0
# 本地修复后：两个版本都 PASS，accepts=1, payTo=0x1111…, network=eip155:10143, amount=10000
# 线上旧构建：FAIL NO_ACCEPTS, bodyBytes=2, headerPaymentRequired=true（部署前预期）
```

部署后应复验（需要真实部署权限，本次未部署）：

1. `curl -si https://app.moneyswitch.dev/x402-testnet/check`：确认 402、`PAYMENT-REQUIRED` 可 base64 解码、body 与解码对象一致（body 约 458 B，不再是 2 B）。
2. `npx @eidonze/mcpreflight inspect https://app.moneyswitch.dev/x402-testnet/check --json`：`finalStatus: PASS`，`accepts[0].payTo` 与说明页地址一致，`network: eip155:10143`，`amount: "10000"`。
3. `node --test apps/demo-seller/receiver.test.mjs` 保持 5/5。
4. 用一笔 **0.01 Monad 测试 USDC** 走一次正常付款（测试币无价值），确认仍能拿到 200 + `PAYMENT-RESPONSE`，并在账单/链上看到这笔；这一步只证明支付链路没被 body 镜像影响，不需要改任何其他支付功能。
5. 部署方式沿用 `docs/x402-receiver.md`：`node scripts/build-receiver.mjs` → 上传 `.data/receiver-release/` → `PAY_TO=<收款地址> sh ./run-receiver.sh`；Caddy 配置不变。

**注意（与本次修复无关的既有问题）**：当前 checkout 里 `scripts/build-receiver.mjs` 生成的 CJS bundle 在本机启动即失败（`packages/db/dist/index.js` 的 `import.meta.url` 在 CJS 下为空），用 HEAD 的 `receiver.mjs` 同样失败，说明是既有打包问题而非本次改动引入。线上部署请沿用实际可用的构建/发布流程；这个问题建议单独开 issue 处理，不要混进 #19。

## 7. 对外回应 / 后续

- **给 issue #19 的回复要点**：402 + body `{}` 是 x402 v2 的规范形态（附规范链接与 header 解码结果）；challenge 在 `PAYMENT-REQUIRED`，检查器报告里 `headers.paymentRequired` 也为 `true`；请 `findPaymentDocument` 先 base64 解码 `payment-required`，并修正 v2 shape 注释；MoneySwitch 已把同一对象镜像进 body，部署后复扫应 PASS。
- **上游 bug**：`@eidonze/mcpreflight` 的 base64 解码缺失（0.2.0–0.5.0 均存在）可直接用 `npx @eidonze/mcpreflight inspect https://app.moneyswitch.dev/x402-testnet/check --json` 复现。
- **不做**：不升级 x402 SDK、不改 `/v1/fetch` 预算/审批/回执、不加其他支付功能；#19 关闭条件是“线上复扫 PASS + 一次测试付款账单”，而不是扩大实现。
