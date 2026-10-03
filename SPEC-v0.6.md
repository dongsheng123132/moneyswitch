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
| 保护方式 | **auto（默认）**：随机 32 字节解锁密钥存于 `<数据目录>/wallet-unlock-<地址>.secret`（文件名带这个钱包的地址；原子写入，永不经任何 API 返回、永不记录），用它加密 keystore，重启自动解锁。**manual**：创建/导入时给密码，不写密钥文件。`env_or_file`：旧的 `MONEYSWITCH_WALLET_PASSWORD(_FILE)`，仍支持。**模式记录在 `wallet.json` 里**（不含秘密的 `x-moneyswitch` 字段，其余钱包软件忽略它；没有该字段的 keystore 一律视为 password），health、总览横幅、`/backup` 都按记录的模式判断，而不是看目录里有哪些文件 |
| 数据目录保护 | auto 模式下服务器把数据目录和密钥文件限制为只有自己的账户可访问，并读回**验证**：Windows 用 PowerShell 设置受保护的 DACL（去掉继承），只允许当前用户 SID 和 SYSTEM（S-1-5-18）两条 allow，用 SID 不用本地化账户名（权限位 0600 在 Windows 上没有意义）；POSIX 目录 0700、密钥 0600。每次启动重新设置并验证。设置或验证失败**不拒绝运行**，但 `health.secret_protected=false`（附原因），钱包页红色警告 + 总览红色横幅 + 启动日志警告 |
| 诚实的取舍 | auto 模式下，**谁能读数据目录谁就能动用钱包**（含备份、磁盘快照、同一系统用户下的 AI）。因此：浮存要小（`MONEYSWITCH_WALLET_FLOAT_LIMIT`，默认 50 USDC，超出后台警告）、团队用独立服务器、`/data` 备份按私钥对待。已有钱包保持原模式，**升级从不自动迁移成 auto** |
| 启动解锁顺序 | `MONEYSWITCH_WALLET_PASSWORD` / `_FILE`（**非空**才算数；空变量、空文件、空白文件、读不了的文件都视为没配置）→ 该钱包自己的解锁密钥 → 保持锁定。**每个来源各自报告结果和原因**（`env_wrong`、`secret_missing`、`secret_empty`、`secret_unreadable`、`secret_wrong`；`health.unlock_sources`、启动日志逐条），记错误日志（不含凭据），`health.auto_unlock_ok=false`，总览横幅，并继续尝试下一个来源；过期的环境变量密码不会被算到密钥头上，反之亦然。对外服务之前先收拾上次崩溃的残留：临时文件删除；不属于当前钱包的密钥**移到 `retired/`**（绝不删除） |
| 开/关自动解锁 | 开：需钱包已解锁，用新随机密钥重新加密并写密钥文件（该钱包名下已有的旧密钥先移到 `retired/`）。关：需新密码（≥8 位），用它重新加密并删除密钥文件。**崩溃安全且不留副本**：新 keystore 先在内存里加密并试解通过、写临时文件、再 rename 覆盖 `wallet.json`（旧文件从不先删）；开时先装密钥再换 keystore、关时先换 keystore 再删密钥，任何一步失败都用 rename 覆盖把文件还原；**不再保留 `wallet.json.bak-*`**，关闭之后磁盘上没有任何东西能不凭新密码打开这把密钥；绝不出现没人能解开的 keystore。开/关时若 `wallet.json` 已不是当前解锁的那个钱包则拒绝（`WALLET_CHANGED`）。win32 上 rename/删除遇到 EPERM/EBUSY/EACCES 会重试 |
| 备份确认 | `POST /v1/admin/wallet/backup/confirm {positions:[i,j], words:[…]}`：服务器核对两个词（后台随机选位置），写入 `wallet_meta.backup_confirmed_at`。未确认前后台任何地方（钱包页、设置向导、右上角地址标签含 Copy 按钮）都不显示地址，也没有二维码和充值步骤；刷新页面后向导用一次点击重新显示短语（页面自己带着地址去请求，不需要也不显示地址）。`POST /v1/admin/wallet/reveal {confirm_address}`：必须原样回填当前地址，返回短语（导入的钱包返回私钥），`no-store`，审计只记「发生过」不记内容。内存里刚生成的短语和它的钱包地址一起保存，只在该地址的钱包上显示 |
| 导入 | `private_key` / `keystore` / `mnemonic`（12 或 24 词，账户 0）。**不管来源是什么，只落盘账户 0 的私钥**：不存助记词、种子或非默认派生路径（短语可能控制很多别的资金，不该放在热钱包服务器上）；`reveal` 返回私钥。导入的钱包视为已备份（凭据是用户自带的），备份状态为 `not_applicable`。只有服务器自己生成的钱包才有短语。可选 `expected_address`：密钥对不上则拒绝（`400 EXPECTED_ADDRESS_MISMATCH`），空字符串或非字符串同样拒绝（不会悄悄跳过检查）。导入页和更换页都有醒目警告：永远不要导入同时控制着其他资金的短语或私钥，服务器上的钱包必须是专用的小额浮存钱包 |
| 更换钱包 | `POST /v1/admin/wallet/replace {confirm_address, …create 或 import 的 body}`。有请求占用着签名器时 `409 WALLET_BUSY`（见「在途付款」）。旧 `wallet.json`（及密钥文件）先**复制**到 `<数据目录>/retired/` 并逐字节核对，再把新文件用 rename **覆盖**到原名（`wallet.json` 任何时刻都不缺失），文件名含旧地址和时间戳，**永不删除**；回滚也是 rename 覆盖回去。`wallet_retirements` 表记录（旧地址、时间、原因、文件名）；写审计；记录失败则整体还原。MoneyKey、预算、审批、付款历史、通知设置原样保留；`unknown` 付款的链上对账读取每笔付款上记录的 `auth_from`，与当前钱包无关，继续有效 |
| 在途付款 | 付款请求（`/v1/fetch`、`/v1/chat/completions`）在能签名之前向驱动**租用**签名器（进程内计数，`finally` 里归还）；有租约时更换钱包和锁定钱包都被拒绝。签名器在 `signTypedData` 时再检查钱包的「世代」：钱包在租约之后被替换或锁定，则**不签名**，付款记录标为 failed（`WALLET_CHANGED`，预算释放），调用方得到 `WALLET_LOCKED` 且 `charged: "no"`。不再用 `payments.status='reserved'` 的数据库行判断 |
| 重启遗留的预留 | 对外服务之前（`buildContext`）：本次启动前创建的 `reserved` 付款，已记录签名授权（`auth_*`）的转为 `unknown`（仍计入预算，交链上对账），没有的转为 `failed`（`RESTARTED_BEFORE_SIGNING`，释放预算），各写一条审计 |
| 健康 | `GET /v1/admin/wallet` 在原有字段之外加 `health`：`protection`（记录的模式 `auto` / `password` / `none`）、`unlock_mode`（`auto` / `env_or_file` / `manual` / `none`）、`auto_unlock_ok`（最近一次真实解密的结果）、`unlock_sources`（每个来源及其原因）、`secret_file_present`、`secret_protected` / `secret_protection_detail`、`orphan_files`（`wallet.json` 丢失但凭据仍在时 `wallet_file_missing=true`，后台据此提示而不是悄悄让人新建）、`backup`（`confirmed` / `missing` / `not_applicable`）、`float_limit`、`over_float_limit`（每条已启用且余额可读的链）、`retired_wallets` |

**不变量**：

1. 任何时刻磁盘上都至少有一个可以被解开的 keystore；改写 keystore 之前先验证新文件能解回同一个地址。
2. MoneySwitch 从不删除属于另一把密钥的钱包文件或解锁密钥，只复制/移动到 `retired/`；也不留下能打开一把已改密码的密钥的旧副本（没有 `.bak`）。
3. 助记词、私钥、密码、解锁密钥不进日志、审计表，也不出现在 create / replace / reveal 之外的任何响应里。
4. 创建和导入不覆盖已有钱包（包括并发请求）；换钱包只能走「更换钱包」。
5. AI 永远拿不到私钥（沿用 SPEC.md §0）：它只有 MoneyKey。

**不做**：Shamir 分片、多签、硬件钱包、BIP-39 口令（第 25 个词）、自动把超出浮存上限的余额转走。
