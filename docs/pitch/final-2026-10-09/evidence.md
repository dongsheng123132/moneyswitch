# MoneySwitch 参赛证据清单

核验日期：2026-10-09（Asia/Shanghai）。本文件只记录实际读取的资料与匿名 HTTP / 公共 RPC 返回；没有创建 key、修改线上配置、签署付款或使用主网资金。RPC 补充核验完成于 12:12。

## 1. 版本与证据边界

- 已核实的产品发布快照是 **v0.7.5**，Git revision `a09310715b14b8d63a55ef55614f3547bbb6490e`。主仓随后出现 `0600d4b944402c081c215edb4598916c0ceb0cf5`（v0.7.6 Dashboard 社区链接）；源码 HEAD 前进不能单独证明线上实例已部署该版。
- [v0.7.5 Release](https://github.com/dongsheng123132/moneyswitch/releases/tag/v0.7.5)；[对应 CI](https://github.com/dongsheng123132/moneyswitch/actions/runs/37877016320)。发布/CI 地址来自本地部署验收记录，以下状态是该记录的结论，不是本次重跑测试。
- 本地记录：`C:/1mineyswitch/.data/us-release/v0.7.5-verification.json`。其中构建、离线测试、HTTPS 健康、公开 skill、部署后 JS/CSS hash、备份完整性均通过；Windows 与 Linux bundle smoke 各 `26 passed`；`real_payments_in_acceptance: 0`；`npm_published: false`。
- 这份材料所在的网站分支与应用发布分支不同。录制前应由操作者记录实际演示实例的 release、commit 和录制日期，不把网站分支版本当作服务版本。
- **历史交易证明当时的链上转账，不证明当前版本 UI、Agent 安装、人工审批和整套流程本次自动跑通。** 金额和成功状态来自 receipt；表中的业务用途来自项目当时的运行记录。
- **链上交易不能证明模型 ID。** Qwen 模型配置和运行记录的证据层级见第 5 节。

## 2. 公开服务的匿名只读检查

以下保留 2026-10-09 部署前勘察结果。随后官网已发布 `82c7839`，新版页面、文章下载和图片共 22 项资源通过公网核验，Windows / Ubuntu CI 均成功。部署后的最终入口见 [deployment-status.md](deployment-status.md)；下面的旧首页标题是历史观察，不代表当前官网。

| 公开入口 | 观察结果 | 能证明什么 |
|---|---|---|
| [官网](https://moneyswitch.dev/) | HTTP 200；核查时标题为 `MoneySwitch — Give your AI an API key for money` | 当时旧官网可访问；不能证明新云钱包首页已发布 |
| [Dashboard](https://app.moneyswitch.dev/) | HTTP 200，页面标题 `MoneySwitch` | 页面可达；它需要登录，不是免登录公开试玩 |
| [健康检查](https://app.moneyswitch.dev/healthz) | HTTP 200，`{"ok":true}` | 服务存活；不证明钱包有余额或 Agent 可完成支付 |
| [测试付款端点](https://app.moneyswitch.dev/x402-testnet/check) | 无付款凭证的 GET 返回 HTTP 402；`scheme=exact`，`network=eip155:10143`，`amount=10000` | 公开报价是 **0.01 Monad 测试 USDC**；此次没有付款 |
| [Qwen / Nansen 英文案例](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/) | HTTP 200，标题为 Qwen 的 0.09 美元预算实验 | 案例文章已公开；交易另经 RPC 核对 |

金额按 USDC 的 6 位小数解释。测试端点只接受测试币，不是美元 API 额度；读到 402 是正常报价，不应写成服务报错。

## 3. 已核实的主网交易：9 笔，共 0.13 USDC

本次对下列每个 hash 调用了公共 RPC `eth_getTransactionReceipt`，均返回 `status=0x1`，并在对应 USDC 合约日志中找到 `Transfer`。9 笔中 **Monad 8 笔、Base 1 笔**；Monad 合计 **0.12 USDC**，Base 合计 **0.01 USDC**。这些是选定历史案例的数量，不是当前用户数、订单总量或营收指标。

| 案例 / 记录日期 | 链 | USDC | Transfer 原始金额 | 完整交易 |
|---|---|---:|---:|---|
| Nansen Token Screener 首笔，9/27 | Monad | 0.01 | 10000 | [0x98297ba4…e5e9c](https://monadvision.com/tx/0x98297ba48601af6b2acc032f280db1c292de1071c754921d24a27464e3ce5e9c) |
| 较早 Qwen 运行中的成功查询，9/27 | Monad | 0.01 | 10000 | [0x70fe782a…975e9](https://monadvision.com/tx/0x70fe782a863de9a20cec88f482fde2d2ea8f8749d7e79e46bee653dbf95975e9) |
| 五查询实验 ①：按成交量筛选，9/27 | Monad | 0.01 | 10000 | [0xb227e30f…d540](https://monadvision.com/tx/0xb227e30f125cac1ab20977a5b9479ae538dacdec4295262173d643febc7ad540) |
| 五查询实验 ②：按涨幅筛选，9/27 | Monad | 0.01 | 10000 | [0xc739c432…163f](https://monadvision.com/tx/0xc739c43296ed40a239bd148b60d6be230bae7a53c5795f68e389056520fc163f) |
| 五查询实验 ③：资金流查询，9/27 | Monad | 0.01 | 10000 | [0x99bf9da6…2cb8](https://monadvision.com/tx/0x99bf9da63699c1e6fd6e487bbbbfea882e882e29af30c6c178b0d277c82a2cb8) |
| 五查询实验 ④：smart-money 筛选，9/27 | Monad | 0.01 | 10000 | [0x5fab3819…f33b](https://monadvision.com/tx/0x5fab3819a066e3f67e57109c2d6ff7f5a460d74fd6b9df4127c4bfbf4f4cf33b) |
| 五查询实验 ⑤：premium netflow，9/27 | Monad | 0.05 | 50000 | [0xb7df9976…e0b6](https://monadvision.com/tx/0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6) |
| 同一钱包购买 Nansen，10/5 | Base | 0.01 | 10000 | [0x69d0f6f0…f2a5](https://basescan.org/tx/0x69d0f6f0cf15d466b8e8d1c7c4ec6b21e24c4ffee6c533b0ba4b03a79688f2a5) |
| 同一钱包购买 Nansen，10/5 | Monad | 0.01 | 10000 | [0xd68d307a…af7e](https://monadvision.com/tx/0xd68d307a0e5c8d40c21803bef61a0a6c55c9f8a8b19cebe594e61f0ecdbeaf7e) |

链与日志字段：

| 字段 | 已核验值 |
|---|---|
| Monad mainnet / RPC | `eip155:143` / `https://rpc.monad.xyz` |
| Monad USDC 合约 | `0x754704bc059f8c67012fed69bc8a327a5aafb603` |
| Base mainnet / RPC | `eip155:8453` / `https://mainnet.base.org` |
| Base USDC 合约 | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| Nansen 案例收款地址 | `0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f` |
| 9/27 两次 Qwen 运行及首笔案例的付款地址 | `0xab094e59e980c45d735f407514bebdfc8a365c6e` |
| 10/5 Base 与 Monad 两笔共同付款地址 | `0xaa622e40b4651f960351fba1ae4dfcb3503c302a` |

五查询实验合计 **0.09 USDC**，与另外四笔分开计数。10/5 的两笔证明同一地址在两条支持链分别付款；**不是跨链桥、兑换或自动搬运余额**。这些实验早于 v0.7.5，不能标作 v0.7.5 的新交易。

## 4. 已核实的测试网交易：7 笔，共 0.21 测试 USDC

全部为 Monad testnet `eip155:10143`，RPC `https://testnet-rpc.monad.xyz`，USDC 合约 `0x534b2f3a21130d7a60830c2df862319e593943a3`。每笔 receipt 为 `status=0x1`，金额来自该合约的 `Transfer` 日志。**测试币没有真实价值，不能与主网 USDC 相加宣传。**

| 历史案例 | 测试 USDC | 原始金额 | 完整交易 |
|---|---:|---:|---|
| 首笔 premium-report | 0.01 | 10000 | [0x1c83a45d…e4d4d](https://testnet.monadvision.com/tx/0x1c83a45dac1fcf2ec466888aca1bd879b07bb27907f1838b3cad6db7e54e4d4d) |
| Claude Code 自主 premium-report | 0.01 | 10000 | [0x1cdf773e…dc2729](https://testnet.monadvision.com/tx/0x1cdf773ecc03c84f3aabaa8b4426fb6d4fd2cfd1c87e77cb8869cd2870dc2729) |
| 管理员批准 deep-report | 0.15 | 150000 | [0x7f599d68…b08e165](https://testnet.monadvision.com/tx/0x7f599d6831f269f58f28726fe2c88f7a2d115636b5ca323ac4ab423b6b08e165) |
| 原测试钱包付款，新测试钱包收款 | 0.01 | 10000 | [0xb52e9566…d9bf982](https://testnet.monadvision.com/tx/0xb52e956608b73e87a6546ce2e8168c7e9d69ed8d8b7732cb855fc8b20d9bf982) |
| 新测试钱包付款，原测试钱包收款 | 0.01 | 10000 | [0xe9b892e0…10bd091](https://testnet.monadvision.com/tx/0xe9b892e043bf031af619167099faba3e16e798b0f79c5a39ee3cadc7c10bd091) |
| 10/4 审批链接实验 | 0.01 | 10000 | [0x59e69aed…4a61cf](https://testnet.monadvision.com/tx/0x59e69aedf742e056c48288a7cae80364042497f5082907e41c733110294a61cf) |
| 10/4 新 Agent 首付实验 | 0.01 | 10000 | [0x10c4d61c…ebad3](https://testnet.monadvision.com/tx/0x10c4d61ca56ff9f45806d80b064ffee3f84a5e29348c365c4426b3b8151ebad3) |

前五笔是 `site-data/testnet-payments.json` 的公开样本，共 **0.19 测试 USDC**；加上后两笔为本表 **0.21**。钱包收款的实验使用独立测试 seller，不说明当前 MoneySwitch 产品提供卖方收费站。早期 Claude 案例当时的接入方式也不能拿来宣传当前仍有 MCP。

## 5. Qwen 与 Nansen 赏金所需证据分别是什么

- 配置来源：[Qwen Agent README](https://github.com/dongsheng123132/moneyswitch/blob/v0.7.5/apps/qwen-agent/README.md)，`QWEN_MODEL` 默认值为 `qwen3.8-max`；实现保留在 `apps/qwen-agent/`。
- 公开叙述：[Nansen / Qwen 案例](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/)，对应源 `docs/blog/qwen-agent-pays-nansen.md`；运行说明是 [docs/nansen-mainnet.md](https://github.com/dongsheng123132/moneyswitch/blob/v0.7.5/docs/nansen-mainnet.md)。
- 原始五查询运行记录仅在本机：`C:/1mineyswitch/.data/agent-runs/2026-09-27T13-13-49-680Z.json`；较早失败与一笔成功查询记录为 `2026-09-27T12-56-50-019Z.json`。这次只摘取交易 hash 与字段名，没有发布原始内容。
- 五查询记录顶层只有 `question`、`events`、`final_answer`，**未保存模型 ID**。默认配置不是实际每次调用模型的不可否认证明；若评委要求提供商使用证据，需要用户补充脱敏的模型请求/用量记录，不能补写不存在的调用日志。
- Nansen 的业务用途需要由调用记录、接口路径和返回内容来佐证；单看一笔 USDC 转账只能证明转账。公开稿可同时链接案例和收据，并说明它是历史实验。

## 6. 当前可展示能力与不能混入的旧内容

当前规格可支持：自托管热钱包、单一出资方、多把 MoneyKey、单笔/日/总额度、允许域名、到期/撤销、**达到或超过**审批线等待人批准、持 key 的人的 PIN 或管理员审批、账单和 `charged: yes/no/maybe`、USDC/x402、默认测试网。

现有旧资料的以下内容不能当作已完成能力：

- `judge-questions-2026-10-cloud-wallet.md` 中的“v0.8、每笔任务备注、子 key 新界面”。任务备注和按任务报表没有实现；子 key 仅有后端。
- `cloud-wallet-architecture-viz.html` 中 `task_id`、用途报告和任务筛选，属于未来方案，不是当前架构。
- 旧 `deck-v2`、`video-script.md`、9/26 视频中的 MCP、OpenAI 模型网关、员工门户、本地桌面控制台和卖方收费站，这些不属于现行产品。
- 老稿“26 条 HTTP routes”已过期；v0.7.5 inventory 有 27 条业务/服务路由，Dashboard 文件 wildcard 另计。不需要把易变路由数作为产品卖点。
- “全球首个”“唯一”“全面防提示注入”“三次独立审计所以安全”等未经充分证实的表述不用于最终提交。

## 7. 素材和剩余交付

- 已有旧视频 `docs/pitch/video/moneyswitch-pitch-v3-share.mp4`：89.3 秒，1920×1080，H.264/AAC，34,672,258 字节，9/26 生成；内容过期，不直接提交。未找到现有 v0.7.x 实操录屏或已验证的公开视频 URL。
- 旧 `deck-v2/shots/deck-print-v2.pdf` 也是旧产品素材，不能冒充现行版本。
- 品牌原件为 `site/assets/img/favicon.svg`，可按比赛格式直接导出高分辨率 PNG；原有 32×32 和 180×180 PNG 图标不够 500px。`site/og.png` 为 1200×630、224,401 字节，但属于横幅，不是独立 Logo。
- 最终待补：当前版本 **≤3 分钟技术实操**、**≤2 分钟团队 Pitch**、视频真实上传地址、实际演示实例版本/录制日期及新交易 hash。按 [recording-plan.md](recording-plan.md) 录制，不把本页历史收据剪成“刚刚完成”的结果。
- 本文件不含评委凭据。健康检查不能证明评委可登录；任何评委访问安排由操作者另行核实，不在公开材料写令牌、PIN、恢复词或共享生产配置。
