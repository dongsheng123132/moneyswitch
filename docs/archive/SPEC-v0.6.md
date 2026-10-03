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
| 付款接口 | `POST /v1/fetch`（唯一的付款入口；2026-10-03 起 OpenAI 兼容网关 `/v1/chat/completions` 已删除，见 §2） |
| 接入 AI | **技能 + key**（粘贴一段话，AI 自己存成技能）；另一种只有直接调用 `POST /v1/fetch` 的原始 HTTP 示例。MCP、OpenAI Base URL、new-api、Codex TOML 片段已删除 |
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

### 原子化精简（2026-10-03，用户拍板：只留原子功能）

**留下**：钱包、MoneyKey（含子 key）、审批 + 推送、账本 / 用量、付款测试页、员工自助门户、技能（每把 key 一份 + `/skill.md`）、Windows 桌面快捷方式、测试网 0.01 收款验证（receiver）、作为测试卖家的 `apps/demo-seller`（`apps/qwen-agent` 按 §4 原样保留）。凡是不属于这些的，都不是核心，删。

**删除**（原因：每一项都是在「钱包 + 有规则的 key + `POST /v1/fetch`」之上又加了一层别的产品，维护面大、安全面大，而核心只需要一条付款路径）：

1. **OpenAI 兼容网关与模型渠道**：`POST /v1/chat/completions`、`GET /v1/models`、`/v1/dashboard/billing/*`、管理员渠道接口（增删改、从上游拉模型列表）、后台「渠道」页、付款测试页的对话模式、安装向导里的渠道步骤、key 的 `allowed_models`（API 和界面里都删；库里的列保留且被忽略）、用量里的模型 / token 列、OpenAI 风格的错误映射。`apps/demo-seller` 里只给网关用的部分（OpenRouter / LLM 代理、`/v1/models`）一并删除，只保留测试用的最小 x402 卖家。旧的 `kind = chat` 付款记录在历史里照常显示（按普通付款）。
2. **「接入 Agent」页**（管理员页和员工页）及导航项。把 key 交给 AI 只保留两种格式：技能（首选）和一个 `POST /v1/fetch` 的原始 HTTP 示例；MCP、Codex TOML、OpenAI Base URL、new-api、「发给同事的消息」片段全部删除。技能入口依然齐全：创建 key、重置密钥（抽屉和行按钮）、安装向导最后一步、员工创建子 key 之后、员工自己那把 key（预算页上的卡片）。
3. **离线 demo**：`moneyswitch demo`、`moneyswitch-server demo`、`apps/server-pkg/src/demo.ts`、服务端 / 后台里只为 demo 存在的分支（横幅、引导卡片、模拟余额、跳过对账、`/v1/setup/status` 与 `/v1/admin/meta` 里的 `demo` 字段）、`pnpm demo:local`。`packages/mock-facilitator` 作为测试夹具保留。
4. **MCP 与 `moneyswitch` 命令行包**：`apps/mcp`、`apps/cli`（它只含 demo 和 mcp）、`GET /dl/moneyswitch.tgz` 及 `/v1/admin/meta` 里的 CLI / MCP 路径字段，并从工作区、根脚本和锁文件里移除。
5. **残留的卖方和已删功能的文案**：钱包页收款卡片里的收费站句子和链接、`PayToField`、词汇表 / 总览 / 导航里的收费站和渠道文案、只讲已删功能的文档（`docs/claude.md`、`docs/codex.md`、`docs/desktop-agents.md`、`docs/demo*.md`）、官网首页和各 README 里的对应段落。

**数据库只增不删**：没有 DROP，也没有删除数据的迁移。`channels` 表、`money_keys.allowed_models`、`payments.model / prompt_tokens / completion_tokens` 等旧列和旧表保留在迁移与 schema 里，只是不再被读写（`payments.kind` 仍被读取，用来显示旧的 chat 记录）。

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
| 启动解锁顺序 | `MONEYSWITCH_WALLET_PASSWORD` / `_FILE`（**非空**才算数；空变量、空文件、空白文件、读不了的文件都视为没配置）→ 该钱包自己的解锁密钥 → 保持锁定。**每个来源各自报告结果和原因**（`env_wrong`、`secret_missing`、`secret_empty`、`secret_unreadable`、`secret_wrong`；`health.unlock_sources`、启动日志逐条），记错误日志（不含凭据），`health.auto_unlock_ok=false`，总览横幅，并继续尝试下一个来源；过期的环境变量密码不会被算到密钥头上，反之亦然。对外服务之前先收拾上次崩溃的残留：临时文件删除；不属于当前钱包的密钥**移到 `retired/`**（绝不删除）。若 `wallet.json` 暂时属于另一把密钥，正确钱包的密钥会被当成孤儿移到 `retired/orphan-wallet-unlock-<地址>-<时间>.secret`；正确的 `wallet.json` 回来后，auto 钱包缺密钥文件时，启动会按**该钱包自己的地址**逐个（新的在前）试 `retired/` 里的孤儿，第一个真能打开当前 keystore 的被**移回原处**并写日志；打不开的不动，仍然锁定时日志写出具体的 `retired/` 文件名，不再笼统地说「请从备份恢复」 |
| 开/关自动解锁 | 开：需钱包已解锁，用新随机密钥重新加密并写密钥文件（该钱包名下已有的旧密钥先移到 `retired/`）。关：需新密码（≥8 位），用它重新加密并删除密钥文件。**崩溃安全且不留副本**：新 keystore 先在内存里加密并试解通过、写临时文件、再 rename 覆盖 `wallet.json`（旧文件从不先删）；开时先装密钥再换 keystore、关时先换 keystore 再删密钥，任何一步失败都用 rename 覆盖把文件还原；**不再保留 `wallet.json.bak-*`**，关闭之后磁盘上没有任何东西能不凭新密码打开这把密钥（同一把密钥被换出又换回时，`retired/` 里仍能打开它的旧解锁密钥也会被删除，见「退役副本」）；绝不出现没人能解开的 keystore。开/关时若 `wallet.json` 已不是当前解锁的那个钱包则拒绝（`WALLET_CHANGED`）。win32 上 rename/删除遇到 EPERM/EBUSY/EACCES 会重试 |
| 退役副本 | `retired/` 里可能留着**同一把密钥**的旧副本和它的旧解锁密钥（A 换成 B 再换回 A）。当前密钥处于 **password 模式**、且密码刚刚证明当前 keystore 可打开时（关闭自动解锁、手动导入/更换、输入密码解锁、启动密码），`retired/` 里每个能打开当前密钥的旧副本的 `.secret` 都被**删除**——这是 MoneySwitch 唯一删除凭据的地方，只在 `retired/` 内，每次删除写审计 `wallet.retired_secrets_removed`（文件名与触发原因 `auto_unlock_off` / `import` / `replace` / `unlock` / `startup_password`）并在响应里返回 `retired_secrets_removed`。**锁定的密码钱包不清理**（一对旧文件可能是唯一入口），只标记。删不掉或锁定时发现的文件列在 `health.retired_secrets_open_live_key`、启动日志警告和钱包页红色一行里。每次最多 100 次解密尝试。auto 模式不删（它自己的密钥本来就能打开） |
| 备份确认 | `POST /v1/admin/wallet/backup/confirm {positions:[i,j], words:[…]}`：服务器核对两个词（后台随机选位置），写入 `wallet_meta.backup_confirmed_at`。未确认前后台的充值/复制场合（钱包页的收款卡片、设置向导、右上角地址标签含 Copy 按钮）都不显示地址，也没有二维码和充值步骤；唯一例外是「更换钱包」对话框：它始终只读地显示当前钱包地址，并注明「这个钱包将被停用，不要再向它转钱」，因为确认更换需要输入这个地址；刷新页面后向导用一次点击重新显示短语（页面自己带着地址去请求，不需要也不显示地址）。`POST /v1/admin/wallet/reveal {confirm_address}`：必须原样回填当前地址，返回短语（导入的钱包返回私钥），`no-store`，审计只记「发生过」不记内容。内存里刚生成的短语和它的钱包地址一起保存，只在该地址的钱包上显示 |
| 导入 | `private_key` / `keystore` / `mnemonic`（12 或 24 词，账户 0）。**不管来源是什么，只落盘账户 0 的私钥**：不存助记词、种子或非默认派生路径（短语可能控制很多别的资金，不该放在热钱包服务器上）；`reveal` 返回私钥。导入的钱包视为已备份（凭据是用户自带的），备份状态为 `not_applicable`。只有服务器自己生成的钱包才有短语。可选 `expected_address`：密钥对不上则拒绝（`400 EXPECTED_ADDRESS_MISMATCH`），空字符串或非字符串同样拒绝（不会悄悄跳过检查）。导入页和更换页都有醒目警告：永远不要导入同时控制着其他资金的短语或私钥，服务器上的钱包必须是专用的小额浮存钱包 |
| 更换钱包 | `POST /v1/admin/wallet/replace {confirm_address, …create 或 import 的 body}`。**钱包处于锁定状态、密码已丢失时也能更换**（只移动文件，从不解密；后端端到端测试：上一版本写的密码 keystore、不给任何凭据启动、更换后新钱包自动解锁、旧文件在 `retired/`、Key 与历史完好）；后台的更换对话框在钱包页（锁定时危险操作区自动展开）和设置向导（解锁表单下方）都可达，锁定钱包的备份页不再提供无法成功的「显示恢复短语」，而是给出两个选择：用密码解锁，或更换钱包（自动解锁钱包则是恢复密钥文件，或更换）。有请求占用着签名器时 `409 WALLET_BUSY`（见「在途付款」）。旧 `wallet.json`（及密钥文件）先**复制**到 `<数据目录>/retired/` 并逐字节核对，再把新文件用 rename **覆盖**到原名（`wallet.json` 任何时刻都不缺失），文件名含旧地址和时间戳，**永不删除**；回滚也是 rename 覆盖回去。`wallet_retirements` 表记录（旧地址、时间、原因、文件名）；写审计；记录失败则整体还原。MoneyKey、预算、审批、付款历史、通知设置原样保留；`unknown` 付款的链上对账读取每笔付款上记录的 `auth_from`，与当前钱包无关，继续有效 |
| 付款方式 | 只签 **EIP-3009**（`transferWithAuthorization`）。`@x402/evm` 对 `extra.assetTransferMethod: "permit2"` 会签 Permit2 授权，它没有 `authorization`（from / nonce / validBefore），也就不会记录 `auth_*`——而重启清扫把「没有 `auth_*`」当成「从没签过」。所以只接受 `assetTransferMethod` 缺省（或 null）或恰为 `"eip3009"` 的要求，其余一律在预留和签名之前拒绝：`UNSUPPORTED_PAYMENT`，`charged: "no"`；同时提供两种方式的卖方按 EIP-3009 那一项付款 |
| 在途付款 | 付款请求（`/v1/fetch`）**在即将创建付款时**（未付费探测之后、卖方已报价）才向驱动**租用**签名器（进程内计数，`finally` 里归还）；免费资源和不付的 402 不占用。锁定钱包在有租约时立即被拒绝。**更换钱包会等**：先设置「排空」标志，此后不再发出新租约（新的付款得到 `WALLET_BUSY`、`charged: "no"`，未预留、未签名），并最多等 60 秒让已有租约结束，超时则 `409 WALLET_BUSY` 且什么都不改——持续的流量因此饿不死更换。签名器在 `signTypedData` 时再检查钱包的「世代」：钱包在租约之后被替换或锁定，则**不签名**，付款记录标为 failed（`WALLET_CHANGED`，预算释放），调用方得到 `WALLET_LOCKED` 且 `charged: "no"`。不再用 `payments.status='reserved'` 的数据库行判断 |
| 重启遗留的预留 | 对外服务之前（`buildContext`）：本次启动前创建的 `reserved` 付款，已记录签名授权（`auth_*`）的转为 `unknown`（仍计入预算，交链上对账），没有的转为 `failed`（`RESTARTED_BEFORE_SIGNING`，释放预算），各写一条审计。这个判断成立的前提是只签 EIP-3009（见「付款方式」） |
| 健康 | `GET /v1/admin/wallet` 在原有字段之外加 `health`：`protection`（记录的模式 `auto` / `password` / `none`）、`unlock_mode`（`auto` / `env_or_file` / `manual` / `none`）、`auto_unlock_ok`（最近一次真实解密的结果）、`unlock_sources`（每个来源及其原因）、`secret_file_present`、`secret_protected` / `secret_protection_detail`、`orphan_files`（`wallet.json` 丢失但凭据仍在时 `wallet_file_missing=true`，后台据此提示而不是悄悄让人新建）、`retired_secrets_open_live_key`（密码钱包：`retired/` 里仍能不凭密码打开当前钱包的解锁密钥文件名）、`backup`（`confirmed` / `missing` / `not_applicable`）、`float_limit`、`over_float_limit`（每条已启用且余额可读的链）、`retired_wallets` |
| 备份 | 数据目录是 0700、文件 0600，属主是服务的 `node` 账户，容器 `cap_drop: ALL`，**root 读不了**：`--user root` 的 tar 会报 Permission denied 却照样生成一份缺 `wallet.json` 和解锁密钥的压缩包。文档里的命令是 `--user node`（或像 `deploy/upgrade-us.sh` 那样在宿主机上以 root 打包数据卷），并用 `deploy/check-backup.sh <压缩包>` 检查：只列出内容（不解压、不显示秘密），`wallet.json` 不在则失败；auto 钱包还必须有**同一地址**的 `wallet-unlock-<地址>.secret`；password 钱包没有解锁密钥，不要求。退出码 0 / 1 / 2（用法） |

**不变量**：

1. 任何时刻磁盘上都至少有一个可以被解开的 keystore；改写 keystore 之前先验证新文件能解回同一个地址。
2. MoneySwitch 从不删除属于另一把密钥的钱包文件或解锁密钥，只复制/移动到 `retired/`；也不留下能打开一把已改密码的密钥的旧副本（没有 `.bak`；`retired/` 里仍能打开当前密码模式密钥的解锁密钥会被删除，这是唯一删除凭据之处，见「退役副本」）。
3. 助记词、私钥、密码、解锁密钥不进日志、审计表，也不出现在 create / replace / reveal 之外的任何响应里。
4. 创建和导入不覆盖已有钱包（包括并发请求）；换钱包只能走「更换钱包」。
5. AI 永远拿不到私钥（沿用 SPEC.md §0）：它只有 MoneyKey。

**不做**：Shamir 分片、多签、硬件钱包、BIP-39 口令（第 25 个词）、自动把超出浮存上限的余额转走。
