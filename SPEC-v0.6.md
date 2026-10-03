# MoneySwitch v0.6 — 收窄范围（权威版）

> 2026-10-02 用户拍板。与 SPEC.md ~ SPEC-v0.5.md 冲突时以本文件为准。
> 初心不变（SPEC.md §0）：让 AI 像用 API Key 一样用钱；AI 永远拿不到私钥；只用现成的轨道（x402、USDC），不发币、不造协议。

## 0. 一句话

企业（或个人）自建一台 MoneySwitch：往钱包里放 USDC，给每个员工、每个 AI 发一把有规则的 MoneyKey。
AI 拿到「一段技能 + 一把 key」就能付任何 x402 服务；超过审批线找人批；每笔都有链上凭证。**只做买方。**

## 1. 做什么

| 部分 | 内容 |
|---|---|
| 服务端 | 不带界面也能跑；管理后台 + 员工门户由同一端口提供 |
| MoneyKey | 日/总预算、单笔上限、域名白名单、审批线、过期、子 key；**重置密钥**（库里只存哈希，原文只在创建/重置时出现一次） |
| 付款接口 | `POST /v1/fetch`；OpenAI 兼容网关 `/v1/chat/completions`（付给 x402 模型卖家，也是 new-api 接入的入口） |
| 接入 AI | **首选：技能 + key**（粘贴一段话，AI 自己存成技能）。备选：MCP、OpenAI Base URL |
| 审批 | 超过审批线 → 推送（飞书 / 企业微信 / Telegram / 通用 webhook）→ 人在后台批 → AI 带 `approval_id` 重发；AI 可用 `GET /v1/approvals/:id` 查进度 |
| 扣款诚实 | 每次返回带 `charged: yes/no/maybe`；签了名但结果不明 → `payment_unknown`，AI 不得自动重试 |
| 多链 | **支持多链，不做跨链、不做兑换**：同一个钱包地址在每条链上各自持有 USDC，卖家收哪条链就在哪条链付。顺序：Monad → Base → 其他。链做成配置表（CAIP-2），不写死任何一条 |
| 部署 | 服务器优先（Docker + HTTPS 反代）；本机自用同样支持 |

### 多链的已核实事实（2026-10-02）
- 官方 x402 SDK `@x402/evm@2.27.0` 内置网络表里有 Monad 主网 `eip155:143`、Base `eip155:8453`、Base Sepolia `eip155:84532`、Polygon `eip155:137` 等；**没有 BSC（`eip155:56`）**。
- BSC 上的 USDC（`0x8AC7…580d`）和 USDT（`0x55d3…7955`）链上实测：`authorizationState`（EIP-3009）和 `nonces`（EIP-2612）都 revert。x402 默认的免 gas 签名付款在 BSC 走不通，只能走 Permit2（需先发一笔 approve，付 BNB gas），而且要有支持 BSC 的 facilitator 和卖家。→ BSC 等有真实卖家再做。

## 2. 删除（本轮）

- **收费站 / 卖方功能**：`packages/tollbooth`、`/t/*`、`/v1/tollbooths*`、收益页、`moneyswitch sell`。删除前打存档 tag `archive/tollbooth-v0.5`，以后要做收款可另立产品。
  - 旧数据库里的表**不 DROP**，只是不再读写。
  - `apps/demo-seller` 保留，仅作测试和演示用的卖家；原来借用自家收费站当假卖家的测试改用它。
  - 粘贴防呆（地址 / MoneyKey / 私钥形状检查）是买方也要的，搬到保留的包里。
- **本机的壳**：`moneyswitch ui`（本机控制台）和 `moneyswitch connect`（往 AI 配置文件里写东西）。本机使用 = 把技能 + key 粘贴给 AI，不再装任何东西。

## 3. 永不做

法币出入金（含「法币买 USDC」和第三方代卖 key）、swap、跨链桥、发币、自造协议、替别人保管钱对外营业。

## 4. 不归本仓库管

AgentVerse、灵签、灯城、服务市场索引是独立的试用场，不在这里开发。`apps/qwen-agent` 原样保留为示例，不再投入。

## 5. 安全前提（沿用 SPEC.md §13）

AI 和 MoneySwitch 在同一台机器、同一个系统用户下运行时，能执行命令的 AI 可以直接改数据库、绕过额度。
企业用法：MoneySwitch 部署在独立的服务器或容器里，AI 只拿 key 远程调用。

## 6. 钱包模型（2026-10-03）

> 起因：一周内两次有人因为丢了钱包密码而取不出钱——本机主网钱包里的 0.52 USDC，和美国服务器测试网钱包（它的自动解锁文件是空的）。根因：服务器每次重启都需要钱包密码，但创建钱包时没人被要求保存它；没有不依赖同一密码的备份；没有任何地方提示「重启会锁住钱包」；密码丢了之后只能换一个全新实例，Key、预算、历史全部丢掉。

**原则：服务器钱包是一笔小额「浮存」热钱包，不该要人记密码；找回靠标准恢复短语。**

| 项 | 约定 |
|---|---|
| 创建 | 由 BIP-39 12 词助记词生成，路径 `m/44'/60'/0'/0/0`（导入 MetaMask / OKX 看到同一个地址，测试里用独立实现推导地址并核对公开向量）。短语只在创建响应里返回一次（仅管理员，`Cache-Control: no-store`），只存在于加密 keystore 里，不进数据库、审计、日志 |
| 保护方式 | **auto（默认）**：随机 32 字节解锁密钥存于 `<数据目录>/wallet-unlock.secret`（0600，原子写入，永不经任何 API 返回、永不记录），用它加密 keystore，重启自动解锁。**manual**：创建/导入时给密码，不写密钥文件。`env_or_file`：旧的 `MONEYSWITCH_WALLET_PASSWORD(_FILE)`，仍支持 |
| 诚实的取舍 | auto 模式下，**谁能读数据目录谁就能动用钱包**（含备份、磁盘快照、同一系统用户下的 AI）。因此：浮存要小（`MONEYSWITCH_WALLET_FLOAT_LIMIT`，默认 50 USDC，超出后台警告）、团队用独立服务器、`/data` 备份按私钥对待 |
| 启动解锁顺序 | `MONEYSWITCH_WALLET_PASSWORD` / `_FILE`（**非空**才算数；空变量、空文件、空白文件、读不了的文件都视为没配置）→ `wallet-unlock.secret` → 保持锁定。来源存在但解不开：记错误日志（不含凭据），`health.auto_unlock_ok=false`，总览横幅，并继续尝试下一个来源 |
| 开/关自动解锁 | 开：需钱包已解锁，用新随机密钥重新加密并写密钥文件。关：需新密码（≥8 位），用它重新加密并删除密钥文件。**崩溃安全**：新 keystore 先在内存里加密并试解通过、写临时文件，旧 keystore 留作 `wallet.json.bak-<时间戳>`，开时先装密钥再换 keystore、关时先换 keystore 再删密钥，任何一步失败都把文件还原；绝不出现没人能解开的 keystore |
| 备份确认 | `POST /v1/admin/wallet/backup/confirm {positions:[i,j], words:[…]}`：服务器核对两个词（后台随机选位置），写入 `wallet_meta.backup_confirmed_at`。未确认前后台不显示充值地址、二维码和充值步骤。`POST /v1/admin/wallet/reveal {confirm_address}`：必须原样回填当前地址，返回短语（私钥导入的钱包返回私钥），`no-store`，审计只记「发生过」不记内容 |
| 导入 | `private_key` / `keystore` / `mnemonic`（12 或 24 词，账户 0）。导入的钱包视为已备份（凭据是用户自带的）；私钥导入没有短语，备份状态为 `not_applicable` |
| 更换钱包 | `POST /v1/admin/wallet/replace {confirm_address, …create 或 import 的 body}`。有 `reserved` 付款时 `409 WALLET_BUSY`。旧 `wallet.json`（及密钥文件）**移动**到 `<数据目录>/retired/`，文件名含旧地址和时间戳，**永不删除**；`wallet_retirements` 表记录（旧地址、时间、原因、文件名）；写审计。MoneyKey、预算、审批、付款历史、通知设置原样保留；`unknown` 付款的链上对账读取每笔付款上记录的 `auth_from`，与当前钱包无关，继续有效 |
| 健康 | `GET /v1/admin/wallet` 在原有字段之外加 `health`：`unlock_mode`（`auto` / `env_or_file` / `manual` / `none`）、`auto_unlock_ok`（最近一次真实解密的结果）、`backup`（`confirmed` / `missing` / `not_applicable`）、`float_limit`、`over_float_limit`（每条已启用且余额可读的链）、`retired_wallets` |

**不变量**：

1. 任何时刻磁盘上都至少有一个可以被解开的 keystore；改写 keystore 之前先验证新文件能解回同一个地址。
2. MoneySwitch 从不删除旧钱包文件，只移动。
3. 助记词、私钥、密码、解锁密钥不进日志、审计表，也不出现在 create / replace / reveal 之外的任何响应里。
4. 创建和导入不覆盖已有钱包（包括并发请求）；换钱包只能走「更换钱包」。
5. AI 永远拿不到私钥（沿用 SPEC.md §0）：它只有 MoneyKey。

**不做**：Shamir 分片、多签、硬件钱包、BIP-39 口令（第 25 个词）、自动把超出浮存上限的余额转走。
