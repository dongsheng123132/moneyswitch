# MoneySwitch

**给 AI 一把有预算的花钱 API Key。** 个人、团队和企业都可以在自己的服务器运行。

官网：[moneyswitch.dev](https://moneyswitch.dev) · [English](README.md) · [自建部署](deploy/README.zh-CN.md)

MoneySwitch 持有加密的低余额钱包，通过 x402 支付 USDC。AI 只拿到 `mk_live_…` MoneyKey。付款前检查总预算、每日预算、单笔上限、域名白名单、父 Key 限制与审批；钱包私钥不交给 AI。

## 从代码运行

需要 Node.js 22+ 和 pnpm。当前 v0.6 改动以本仓代码为准，npm 上旧版本不代表这个工作树。

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server-pkg/dist/cli.js --data-dir ./data
```

打开首次启动的设置链接，创建钱包（会显示 12 个词的恢复短语），再为每个 AI 建一把 MoneyKey。在后台点「交给你的 AI」，复制这把 Key 的个性化 skill 给 Claude Code、Codex、OpenClaw 或 Hermes。每个 AI 保存独立 Key。Key 仅存哈希，丢失时点「重置密钥并复制 skill」；旧密钥立即失效，预算与历史保留。超过审批阈值的付款会停在「审批」页（可推送到飞书、企业微信、Telegram 或 webhook）；「用量流水」是账本；「付款测试」可以在浏览器里真实付一笔 x402。

公开 `GET /skill.md` 是不含 Key 的通用说明。`skills/moneyswitch-pay/SKILL.md` 也是通用版本。接入方式只有 skill + Key，另外就是直接调用 HTTP 接口 `POST /v1/fetch`。

## 自己的服务器

[部署说明](deploy/README.zh-CN.md) 提供 Docker Compose、HTTPS/Caddy、持久数据卷、健康检查、备份和回滚。官网和服务后台可以分开部署，例如官网 `moneyswitch.dev`，自用后台 `app.moneyswitch.dev`。服务无需依赖该域名，也能部署到你的企业域名。

管理员控制钱包、Key、审批和通知；团队成员用自己的 Key 查看预算与付款历史。可设子 Key，父级限制始终生效。SQLite 数据卷只运行一个写入实例。

## 支持的链

| 网络 | CAIP-2 |
|---|---|
| Monad 测试网 | eip155:10143 |
| Base Sepolia | eip155:84532 |
| Monad 主网 | eip155:143 |
| Base 主网 | eip155:8453 |

默认保持 Monad 测试网；部署模板同时允许两个测试网。`MONEYSWITCH_NETWORKS` 指定允许列表，`MONEYSWITCH_DEFAULT_NETWORK` 必须在其中。明确启用主网才会支付真实 USDC。每条链只允许它的指定 USDC，不换币、不跨链；余额、付款和对账按实际链记录。

## 接口与付款结果

- `POST /v1/fetch`：受预算保护的 HTTP 请求。
- `GET /v1/status`、`GET /v1/history`：当前 Key 的余额和历史。
- `POST /v1/keys/:id/rotate`：管理员重置密钥。
- `GET /healthz`：服务健康。

付款结果带 `charged: yes/no/maybe`。发送签名后超时、缺结算凭证或响应中断时，不盲目重试；保留预算预留并对账，避免重复付款。审批通知使用独立 outbox，可配置飞书、企业微信、Telegram 或 webhook。

v0.6 聚焦买方基础设施，已移除卖方收费亭、`sell`、本机 UI 和自动修改 AI 配置的命令。随后的“原子化”精简又移除了 OpenAI 兼容网关与模型渠道、离线 demo、MCP 服务和 `moneyswitch` 命令行包。历史数据库表和列保留（不再读写），旧实现归档于 `archive/tollbooth-v0.5`。demo-seller 仅用于测试。

## 验证与许可

```sh
pnpm test
pnpm test:e2e
```

离线测试使用真实签名和模拟结算，不代表真实链上付款。部署验收另核对 HTTPS、持久化、重启和备份。

服务端、核心和 Dashboard：AGPL-3.0-only；`apps/demo-seller` 和 `apps/qwen-agent`：Apache-2.0。详见各包 LICENSE。
