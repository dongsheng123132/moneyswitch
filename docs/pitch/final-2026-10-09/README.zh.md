# Metropolis 最终参赛材料准备包

核验日期：2026-10-09（Asia/Shanghai）。当前状态是**本地准备，尚未提交表单**。本目录为新材料，没有覆盖已有 `docs/pitch/submission.md` 或评委稿，也不包含真实凭证。

## 材料怎么用

- `submission-fields.json`：英文表单值的真相源，包含字符数、已知限制和缺口。未知视频 URL、X 账号和未确认的 Alibaba 字段保持 `null`。
- `submission.en.md`：相同英文内容的可读版本。复制时只取相应字段正文，不把 `Author note`、字符计数、上传要求等编辑说明粘进表单。
- 本文件：中文填写说明、待补事项和英文录制口播稿。
- `submission-workbench.html`：逐字段复制工作台，通过本地 HTTP 服务打开；启动方式见 `deployment-status.md`。直接双击 HTML 时浏览器可能拦截读取 JSON，离线取稿可用上面的 Markdown。
- `evidence.md`：实际交易与公开服务检查证据；`recording-plan.md`：两段视频的详细录制步骤。
- `deployment-status.md`：官网发布结果及仍待完成的提交事项。
- 压缩包内另含 `site/assets/img/moneyswitch-logo-512.png`，可直接上传参赛表单。

以后改成稿，先改 JSON 对应 `value`，重新计算 `characterCount`，再同步英文 Markdown。不要在这两份可提交到代码仓库的文件中加入管理员令牌、MoneyKey、PIN 或恢复词；实际评委凭证只填写到官方表单的私密栏。

## 已确认的表单要求

官方截图与公开表单 JavaScript 已确认：项目名上限 120 字符，一句话 200 字符；Description、Go-to-market strategy 均必填且各上限 8000 字符；评委访问说明可选、上限 8000 字符。Nansen 集成说明必填，上限 8000 字符。

截图确认截止：**2026-10-14 11:59 GMT+8**。赛事只计六周活动窗口内的新工作，提交前用公开仓库历史核对哪些实现属于这次活动，不把整个历史项目都算作新增。

| 字段 | 本次准备情况 |
|---|---|
| 主赛道 | 保留已经选中的 Trust, Identity & AI Infrastructure |
| Project name | 改为 **MoneySwitch**，不要保留当前账号名 |
| One-line description | 已写，153 / 200 字符 |
| Description | 完整英文稿，低于 8000；以 JSON 中计数为准 |
| Go-to-market strategy | 真实目标用户和未来招募计划，低于 8000，没有编造用户数 |
| GitHub repository | `https://github.com/dongsheng123132/moneyswitch`，替换误填的 GitHub Pages 地址 |
| Live product | `https://app.moneyswitch.dev`；首页、`/healthz` 和测试接口 HTTP 402 响应已通过匿名只读检查，当前应用版本、登录流程与评委凭据仍需实操核验 |
| Technical demo URL | **必填，待录制并提供真实 URL，最多 3 分钟** |
| Pitch URL | **必填，待录制并提供真实 URL，最多 2 分钟** |
| Judge access instructions | 已写自托管评估路线；隔离的托管评委实例与私密凭证仍待配置 |
| Nansen explanation | 已写研究流程、五笔主网交易和源码证据 |
| Nansen demo URL | 可选，最多 2 分钟；尚无实际 URL |
| Alibaba / Qwen 必填链接 | **等待展开后的准确字段说明，不能猜是视频、产品还是源码链接** |
| Product ad URL | 可选，最多 30 秒；尚无实际 URL |
| X profile | 可选；真实账号未提供，保持空值 |

Logo 使用 `site/assets/img/moneyswitch-logo-512.png`，官网路径为 `https://moneyswitch.dev/assets/img/moneyswitch-logo-512.png`。官方允许 PNG / JPG / WebP，最大 2 MB、至少 500 px、最多 400 万像素。本地文件已核验为 PNG，512 × 512，总像素 262144，文件 82658 字节，满足这些尺寸和大小限制。本地文件与官网公开 URL 均已核验，仍需用户在表单中实际上传；网站发布不等于完成表单上传。

赏金保留 Nansen 和 Qwen 的已有实际集成证据。Mera 没有实现，需在提交界面移除相应选择；本轮没有操作账号或更改选项。

## 官网发布与当前验收状态

官网已发布 `82c7839`，对应 [GitHub Pages 运行记录](https://github.com/dongsheng123132/moneyswitch/actions/runs/37883060669)。公网 22 项资源与源文件一致：8 个网页、6 份 Markdown、8 张 PNG。TinyFish 还从独立外部网络验证了素材页、新文章和贡献页。官网文章、试用、贡献入口均已上线。

应用首页、`/healthz` 与测试接口的 HTTP 402 响应已通过匿名只读检查。这些检查未验证当前应用版本、登录后的实际流程或评委凭据；录制和提交前仍需完成实操确认。

## 定位和事实边界

统一说法是“给 AI Bot 用的可编程 Web3 云钱包”。云钱包指部署者自己控制的服务，一个出资方、多个独立 MoneyKey；不是让陌生客户注册充值的平台。Web3 指当前已实现的 USDC / x402 支付路径，支持 Monad 和 Base，不能扩写成任意链、任意网站或模型订阅代付。

不把版本固定在旧号上：稿件使用 `current self-hosted release`。功能事实审查基线为 v0.7.5 / `a093107`，提交前另核对实际线上版本。

保留的关键能力：日额度、总额度、单笔上限、域名和过期约束；达到或超过审批线时由持 Key 的人用确认码或管理员审批；批准不能绕过硬额度；账单说明 `charged: yes / no / maybe`，交易号在可确认时提供。服务端仍是热钱包，需要与 Agent 的系统权限隔离。

五笔 Qwen / Nansen 付款是 2026-09-27 的**一次历史演示**，总计 0.09 USDC，不是五个用户、流量指标，也不是当前线上版本的重新验收。不要采用旧草稿中尚未实现的任务用途审计、子 Key 管理界面、MCP 或 Mera，不声称行业首个、唯一或经过独立机构安全审计。

## 录视频前先把真实演示跑通

技术演示必须展示产品，不能用幻灯片或代码讲解代替。建议在独立测试网实例上，用两把测试 Key 走一条完整流程：

1. 0:00–0:20：展示钱包页和测试网标识，说明测试 USDC 无真实价值。
2. 0:20–0:55：展示 A、B 两把 Key 的独立额度，A 无审批线，B 审批线 0.01；隐藏真实 Key、PIN 和管理员凭证。
3. 0:55–1:30：让 A 按生成的技能完成首笔测试付款，展示结果。技能已经触发首付时，不再手动重复付款。
4. 1:30–2:10：展示 B 到达审批线后等待，人在审批页确认，再继续同一个请求。录屏不要拍进 PIN。
5. 2:10–2:40：查看账单、扣款状态和已确认交易哈希；撤销 A，再只查询 `GET /v1/status`，展示被拒绝。
6. 2:40–2:55：回到产品，说明自托管、多 Agent 权限与热钱包边界。

这是录制安排，不是已录好的视频，也不是已经完成的验收证据。录完再剪至 3 分钟以内，上传可访问的视频并填写真实 URL。如果要另做 Nansen 视频，将真实研究工具调用、预算和对应账单剪成最多 2 分钟；不要暗示历史付款是刚刚重新执行的。

## 两分钟英文 Pitch 口播稿

以下是待录制稿，不是视频链接。用户已确认公开称呼为“贺去病（hecare）”，以项目创建者身份介绍；团队人数、其他成员与履历没有确认，不作推断。先实读计时，控制在 2 分钟以内。

> Hello, I'm hecare, also known as 贺去病, the creator of MoneySwitch.
>
> AI bots can write code and choose tools. When a tool asks for payment, the operator needs a clear answer: how much can this bot spend, and when should it ask a person?
>
> MoneySwitch is a programmable Web3 cloud wallet for AI bots. You host the wallet service yourself. Your laptop agent, desktop agent and cloud bot each receive a separate spending key. The private key stays on the server.
>
> The service checks budgets and allowed hosts before signing. Payments at or above an approval threshold wait for a person. You can inspect the payment record and revoke an individual key when its permission should end.
>
> Today the payment path is USDC over x402 on Monad and Base. In a recorded Monad mainnet experiment, a Qwen research agent selected five Nansen queries within a nine-cent budget.
>
> The server remains a trusted hot wallet. Our first evaluation uses test coins, two keys, an approval and a bill. We want feedback from developers already running multiple agents: can they deploy it, understand it and keep control of what their bots spend?
>
> The code is public, and focused contributions are welcome. Our goal is a wallet that fits the agents people actually run.

## 可选 30 秒英文介绍稿

这是可选广告视频的口播草稿，不代替必填技术演示或 Pitch。正常语速试读后压到 30 秒以内，使用真实产品画面。

> Your AI bots can choose tools. You choose what they can spend.
>
> MoneySwitch is a programmable Web3 cloud wallet you host yourself. Give each bot a separate key, set budgets, require human approval and inspect the bill.
>
> It pays supported USDC x402 services on Monad and Base. Start with test coins, then help improve it at moneyswitch.dev.

## 最终提交前剩余动作

上传已验证的 Logo，补齐两个必填视频 URL，并展开确认 Alibaba 链接字段。官网文章、试用、贡献和素材链接已上线核验；继续确认应用版本、登录流程，并准备隔离的测试网评委环境；需要提供的凭证只进入私密表单栏，准备评审后的撤销或轮换方式。由本人按已确认身份录制介绍，不推断团队规模，并确认六周内新增工作的范围。完成这些后再审一遍字段和赏金选择，最后执行提交；本材料没有执行任何外部提交。
