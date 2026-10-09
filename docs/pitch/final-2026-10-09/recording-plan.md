# MoneySwitch 最终参赛视频录制计划

日期：2026-10-09。产品定位：**给 AI Bot 的可编程 Web3 云钱包，由使用者自托管**。出镜公开称呼：**贺去病 hecare**。

本文件是待真人执行的拍摄脚本，不是已录制、已验证或已上传的视频。技术实操成片不超过 3 分钟；团队 Pitch 不超过 2 分钟。中文或英文任选一种口播，另一种可做字幕，不在同一时段连续读两遍。

## 1. 开拍前需要真人提供和完成的输入

| 输入 / 准备 | 要求 |
|---|---|
| 演示版本 | 操作者选择实际可运行的当前发布版，记录 release、commit、录制日期。素材草稿引用的 v0.7.5 不是“线上永远最新”的断言。 |
| 独立实例 | 单独数据目录、数据库和测试钱包，只启用 Monad 测试网。与 Agent 的系统权限隔离；演示跨设备时，提供这两端都可访问的 HTTPS 地址。不能为了录制改共享生产实例。 |
| 钱包准备 | 真人在不录屏时创建钱包、保存恢复词，领取 Monad 测试 USDC。两笔成功测试共花 0.02 测试 USDC，准备足够测试余额。测试币无真实价值，不使用主网资金。 |
| 两位 Agent | 例如真人实际能运行的 Codex 与 Claude Code，或两台设备上的同类 Agent。记录真实 Agent 名称与运行地点；只有一个进程时就标明“同一 Agent 的两个独立会话”，不要冒充两台设备。 |
| 两把 root MoneyKey | 只用于本次录制，按下表配置，给对应 Agent 各一段生成的技能。确认码由真人保管。创建、首次秘密展示及技能粘贴时暂停录屏，或只捕获不会露出秘密的区域。 |
| 真人出镜与声音 | 贺去病 hecare 确认公开称呼，选择口播语言，真实出镜或以本人声音讲解。不编造共同创始人、履历、客户或付费用户。 |
| 提交资料 | 录完后由操作者给出真实视频上传链接、总时长、录制实例版本与两笔新 hash。暂缺的字段保持待补，不编 URL。 |

两把 key 在发行时设置；**发行后不能直接修改额度或审批线**，配错就撤销并重发：

| 配置 | Agent A：`demo-direct` | Agent B：`demo-approval` |
|---|---|---|
| 网络 | Testnet | Testnet |
| 总额度 / 日额度 | 0.05 / 0.05 测试 USDC | 0.05 / 0.05 测试 USDC |
| 单笔上限 | 0.02 测试 USDC | 0.02 测试 USDC |
| 金额审批线 | 留空 | 0.01 测试 USDC |
| 允许测试接口 | 勾选；包含 `app.moneyswitch.dev:443` | 同左 |
| PIN | 真人保管，不给 Agent | 真人保管，不给 Agent |

测试接口为 `https://app.moneyswitch.dev/x402-testnet/check`，本次核验报价是 0.01 测试 USDC。开拍前可以匿名读取报价，但不能把 402 报价当成成功付款。若报价变了，先重新核对脚本和两把 key 配置，别在录制中临时提高主网额度。

**首付只做一次。** 勾选测试接口后，生成技能已经要求 Agent 查询额度并发起首付。接入后观察这个请求，不再手动重复同一笔。为了让两段画面顺序清楚，先交付 A 的技能并录其结果，再交付 B；不要让 B 的待审批请求在录制之前就过期。

## 2. 技术实操：目标 2 分 58 秒

拍真实当前 UI、真实 Agent 对话和真实测试网结果。以下时间是成片节奏，不是网络耗时承诺。若查询、生成或结算较慢，可剪掉等待，并清楚标注“等待已剪短 / Waiting time shortened”；保留同一请求到审批、账单和交易号的关联，不拼接不同请求制造成功。

| 成片时间 | 实拍画面与动作 | 中文说词 / 字幕 | English narration / caption |
|---|---|---|---|
| 00:00–00:12（12s） | 标题，真人或实际桌面；角标写版本、录制日期、`Monad testnet`。 | 我是贺去病 hecare。这是 MoneySwitch：给 AI Bot 的可编程 Web3 云钱包。这次演示全部使用没有真实价值的测试币。 | I'm hecare. This is MoneySwitch, a programmable Web3 cloud wallet for AI bots. This demo uses test tokens with no monetary value. |
| 00:12–00:32（20s） | 实际测试实例的 Wallet 页与运行环境标签；展示同一钱包、测试网余额。不要展示恢复词、登录链接或服务器凭据。 | 钱包运行在我控制的独立服务器上。两个 Agent 共用这个出资方的钱包，拿到各自的访问 Key，不拿钱包私钥。 | The wallet runs on an isolated server I control. Two agents share one payer's wallet through separate access keys, without receiving its private key. |
| 00:32–00:55（23s） | Keys 页展示两把预先创建的测试 key 的名字与策略。根据实际当前 UI 打开详情；不展示完整 token。 | 两把 Key 的单笔上限都是 0.02，日额度和总额度都是 0.05。A 不设金额审批线，B 的审批线是 0.01。 | Both keys have a 0.02 per-payment cap and 0.05 daily and total budgets. A has no amount-approval threshold; B's threshold is 0.01. |
| 00:55–01:22（27s） | A 接收技能后的真实对话：查询额度、首付、返回 `charged: yes` 和新 tx hash。技能粘贴过程不进入画面。 | A 的技能已经发起一次 0.01 测试 USDC 付款。它在已允许的域名和额度内完成。这里是实际返回的付款状态和交易号。 | A's generated skill makes one 0.01 test-USDC payment. It fits the allowed host and spending limits. Here are the actual payment result and transaction hash. |
| 01:22–01:57（35s） | 再接入 B，展示 `approval_required` 和当前请求；真人打开审批页，在遮蔽输入内容的情况下输入 B 的 PIN，点击批准；Agent 按技能继续同一请求。 | B 请求相同金额，刚好达到审批线，所以先停下来。确认码只由我保管。我批准后，Agent 带审批 ID 继续这一个请求。 | B requests the same amount and reaches its approval threshold, so it waits. I keep the confirmation PIN. After I approve, the agent continues this request with its approval ID. |
| 01:57–02:19（22s） | Bills 页展示 A、B 两条对应付款；点开其中一条浏览器收据，显示实际成功状态和 0.01 测试币。 | 两笔记录按 Key 区分，能看到金额、网址、链和交易号。两笔都是测试付款，不是美元 API 额度，也不是主网收入。 | The bills identify each key, amount, URL, chain and transaction hash. Both are test payments, not dollar API credits or mainnet revenue. |
| 02:19–02:36（17s） | 真人撤销 A；在 A 会话只查询 `GET /v1/status`，展示实际被拒。无需再付一笔；B 的独立 key 仍在列表。 | 我撤销 A，只让它再查一次状态。后续请求被拒绝。撤销不会退回已经结算的钱，也不会撤销 B 的独立 Key。 | I revoke A and ask it only to check its status. Future requests are refused. Revocation does not reverse settled payments or revoke B's separate key. |
| 02:36–02:50（14s） | 简单当前架构图：Agent → MoneyKey → HTTP `/v1/fetch` → 服务端策略与签名 → x402 seller；图中标“示意”。可辅以当前代码文件名，不用旧 MCP 图。 | HTTP 请求进入服务，先查额度和权限，再签名。硬额度不能靠审批突破。服务仍是热钱包，所以必须保护服务器并隔离 Agent 权限。 | HTTP requests reach a service that checks limits before signing. Approval cannot override hard caps. This is still a hot wallet: protect the server and isolate agent permissions. |
| 02:50–02:58（8s） | 官网与源码链接结尾；只显示实际公开可访问的地址。 | 当前支付支持兼容的 USDC 和 x402 服务。欢迎自托管试用，并提出具体反馈或 PR。 | Today it pays compatible USDC and x402 services. Try self-hosting it and share a focused issue or PR. |

控制节奏时优先保留实操证据，减少开场修饰。若两笔实际付款无法在录制条件下完成，应保留失败原因并重新安排录制；不能用历史 hash、假 UI、配音或 mock 流程伪装成功。

## 3. 录制中不同结果怎样处理

- `approval_required` 是 B 的预期结果。批准后依技能携带同一个 `approval_id` 继续；这不是发起第二笔演示。
- `charged: maybe`、签名后超时或结果不明：停下，查看 Bills/对账状态，**不自动重试**，不把画面剪成成功。
- 水龙头不可用、Agent 无法访问实例、钱包没余额：不要转主网币救场。先解决独立测试环境问题，或如实留下失败段落再补录。
- 没有达到审批线却弹出新域名审批：检查测试域名是否在 key 的允许列表；别把域名审批误讲成金额审批。
- 撤销后的拒绝按实际响应展示；不要预写未经观察的状态码或错误字符串。
- 只在新建的隔离实例里发 key、批准和撤销；不改共享生产 key、管理员令牌、钱包或实例网络。

## 4. 团队 Pitch：目标 1 分 56 秒

以贺去病 hecare 本人出镜或本人真实口播为主，可插入本次新录的少量界面镜头。不要把旧营销动画冒充现场操作。两种语言任选一种讲，字幕翻译不额外增加时长。

| 时间 | 画面 | 中文口播 | English narration |
|---|---|---|---|
| 00:00–00:12（12s） | 真人，姓名条 `贺去病 hecare · MoneySwitch`。不加未确认职位或履历。 | 大家好，我是贺去病 hecare。我在做 MoneySwitch，一个给 AI Bot 用的可编程 Web3 云钱包。 | Hi, I'm hecare. I'm building MoneySwitch, a programmable Web3 cloud wallet for AI bots. |
| 00:12–00:33（21s） | 真人为主，辅以多设备/Agent 示意。 | 当我们同时在电脑和云端运行多个 Agent，它们可能需要买数据、调用付费服务。我想解决的问题是：怎样集中管理它们能花多少、什么时候需要人批准，而不用把钱包私钥交给每个 Agent。 | When we run agents across computers and cloud machines, they may need to buy data or call paid services. I want to manage their budgets and approvals in one place, without handing every agent a wallet's private key. |
| 00:33–00:58（25s） | 插入当前新 UI 的两把 key 与审批画面，标注实录版本。 | MoneySwitch 由使用者自托管，一个实例服务一个出资方。每个 Agent 拿一把 MoneyKey，服务在签名前检查额度和允许域名。达到审批线就等人批准，花完有账单，也可以单独撤销一把 Key。 | MoneySwitch is self-hosted, with one payer per instance. Each agent gets a MoneyKey. The server checks spending limits and allowed hosts before signing. At the approval threshold it waits for a person, records the payment outcome, and lets you revoke one key independently. |
| 00:58–01:20（22s） | 历史案例页与收据，明确角标 `Historical experiment · September 2026`；与本次测试实录分开。 | 当前付款使用 USDC 和 x402，支持 Monad 与 Base。我们公开了历史 Nansen 数据购买实验，其中五次查询合计 0.09 USDC，收据可查。这证明了具体支付流程，不是用户规模或营收。 | Payments currently use USDC and x402 on Monad and Base. Our published Nansen experiment includes five queries totaling 0.09 USDC, with verifiable receipts. It demonstrates a payment path, not user scale or revenue. |
| 01:20–01:42（22s） | 回到真人，背景可放“Self-hosted / One payer / Testnet first”。 | 我们选择先把范围做清楚：默认测试网，不代付所有模型订阅，不做客户存款账户。它仍然是热钱包，需要保护服务器。下一步想从开发者的真实试用中，找出部署、审批和查账最难用的地方。 | We are keeping the scope clear: testnet by default, no arbitrary model subscriptions, and no customer deposit accounts. It remains a hot wallet that needs a protected server. Next, we want real developers to show us where deployment, approvals and bills are hard to use. |
| 01:42–01:56（14s） | 真人与实际官网/贡献入口。 | 如果你也在运行多个 Agent，欢迎试一笔测试付款，提出问题，或用一个小 PR 改进它。我们希望把它做成你愿意自己部署和掌控的 Agent 支出钱包。 | If you run multiple agents, try a test payment, report a problem, or contribute a small PR. We want to build an agent spending wallet that you choose to host and control. |

若要加入个人经历、其他成员、单位、过往项目或牵引数据，必须由真人提供并确认；本稿没有替用户编造这些信息。若特别强调 Qwen 3.8 Max 使用，应同时按 [evidence.md](evidence.md) 补充模型使用证明，不能声称链上收据能识别模型。

## 5. 导出与提交前检查

1. 技术视频实际时长 **≤180 秒**，团队视频 **≤120 秒**；目标分别为 178、116 秒，留少量余量。检查最终导出文件，而不只看剪辑时间轴。
2. 两支片分开命名，例如 `moneyswitch-technical-demo-YYYYMMDD.mp4` 与 `moneyswitch-team-pitch-YYYYMMDD.mp4`。建议 1920×1080，字幕可读、口播清楚；按提交页实际支持格式导出。
3. 从头检查：没有完整 MoneyKey、PIN、管理员令牌/登录链接、恢复词、私钥、环境变量凭据或原始日志；URL 的敏感参数也要遮掉。保留可公开交易 hash 和测试网标签。
4. 两次付款的 Agent 结果、Bills 和 explorer 必须是同一批真实录制数据。记录实际两笔 hash，并注明测试网；不要沿用 `evidence.md` 的旧收据冒充本次交易。
5. 任何等待剪辑、历史收据、架构示意都明确标注。旧 MCP、模型网关、员工门户、收费站画面不混入当前产品演示。
6. 不写全球首个、绝对安全、完全防提示注入、自动盈利、已实现任务备注或子 key UI。不把协议支持说成所有网站/订阅都能付。
7. 上传后用未登录窗口检查两个链接可播放、音画和字幕正常、无额外访问申请，确认分别对应技术与团队视频。真实上传前不在参赛表填虚构地址。
8. 演示结束后只清理本次创建的测试 key/测试环境，保留原始录屏和脱敏验收记录用于复核。任何共享生产配置和主网资金不在此拍摄计划范围内。

## 6. 完成后由操作者填写

| 字段 | 实际值 |
|---|---|
| 录制日期 / 时区 | 待真人录制后填写 |
| 实例 release / commit | 待核实录制实例后填写 |
| 两位 Agent / 实际运行地点 | 待真人确认 |
| A 交易 hash / 测试网 | 待实际付款后填写 |
| B 交易 hash / 测试网 | 待实际付款后填写 |
| 撤销后实际响应 | 待实操后填写 |
| 技术视频文件 / 时长 / 可播放 URL | 待导出与上传后填写 |
| 团队视频文件 / 时长 / 可播放 URL | 待导出与上传后填写 |
| 未登录播放与秘密检查 | 待检查后填写 |
