# MoneySwitch 云钱包定位梳理（2026-10-06）

> 定位从「x402 付款服务器」升级为「**可云自托管的可编程多 agent 支出钱包**」。
> 本文梳理：为什么这个定位更好、要做什么（与 v0.7 的差距）、服务端钱包怎么更安全、免 gas 方案、竞品位置、给评委的提问（提问见同目录 judge-questions-2026-10-cloud-wallet.md）。

---

## 1. 定位升级：从「付款服务器」到「云钱包」

**v0.7 的一句话**：AI 拿一把有额度的 key 去付 x402，超过审批线找人批，私钥永远不交给 AI。

**新定位的一句话**：**一个组织所有 AI 共用的、可自托管的可编程云钱包**——部署在服务器上，由人统一控制额度和权限，给多台电脑、办公室、云端、服务器上的各种 AI Agent 用，私钥永不交给 AI；**每一笔花钱都有任务备注和缘由，可追溯、可审计**。

两者的关系：v0.7 是「支付服务器」，新定位是「**资金治理层**」。x402 只是支付轨道（HTTP 402 → 签名 EIP-3009 授权 → 结算）；云钱包是站在轨道之上的**账本与治理层**——发 key、管额度、记用途、做审计。这与之前调研的结论一致：「站到网关之上做账本/治理层，不复刻 new-api」。

**为什么这个定位更好**（对比 v0.7 的自我描述）：
- v0.7 讲的是「怎么付」；云钱包讲的是「**谁来花、花多少、为什么花、花完怎么查**」——这是企业/个人给 AI 花钱时的真实决策链路。
- v0.7 的「一台只替一个出钱的人花钱」没有变，只是从「一个出钱的人、一把 key」扩展成「一个组织、所有 AI、每 AI 一把 key、每笔有任务」。
- 云钱包天然带出**审计、治理、合规**这些词，对评委和真实用户都比「支付服务器」更有记忆点。

## 2. 为什么 MetaMask 适合 x402、但不适合做云端钱包

| 维度 | MetaMask（浏览器钱包） | 云钱包（MoneySwitch 的定位） |
|---|---|---|
| 使用场景 | 人在浏览器前，交互式 | agent 在服务器/云端，无人值守 |
| 私钥位置 | 浏览器扩展本地（自我保管） | 服务器端加密保管，**永不交给 agent** |
| 支付方式 | 弹窗 1 键批准（EIP-1193 交互） | HTTP API：`POST /v1/fetch` + MoneyKey |
| 谁在付款 | 人点一下 → 钱包签名 | 服务端按策略签名 EIP-3009 |
| 多 agent 共用 | 不适合（一个扩展一个钱包） | 天生多 agent：一 pool、多 key、多子 key |
| 自托管 | 是（本地） | 是（服务器，Docker/HTTPS/备份） |

**MetaMask 适合 x402 场景的原因**：x402 的付款动作是「客户端预构建并签名支付交易，服务端或可选 facilitator 提交、结算后返回内容」——浏览器钱包正好扮演「签名终端」，人在页面上 1 键批准授权（EIP-3009 transferWithAuthorization），不需要私钥出浏览器。这是人机交互场景的最优解。

**云端为什么不行**：服务器上没有浏览器、没有人在场点击。如果让 agent 进程持有私钥去签 x402，等于「把私钥交给 AI」——这正是 MoneySwitch 明确不做的事。MetaMask 官方 2026-09 也发布了面向 AI agent 的**非托管**钱包方案（Edge&Node 的 agentic commerce map 显示 MetaMask 在做 self-custodial 多链 agent 支付、Gator CLI 管开发侧密钥），但它是嵌入式/SaaS 形态，不是自托管服务器。所以「浏览器钱包做支付终端、云钱包做资金控制器」是两个物种，MetaMask 正好是反证：它自己也在往 agent 支付的方向走，证明这个需求存在，而自托管 + 任务审计 + x402 原生这条线没人占。

## 3. 云钱包要做什么（v0.8 增量）

### 3.1 已具备（v0.7，占目标的约 60%）
- 钱包：助记词创建、重启自动解锁、安全更换、解锁文件 ACL
- Key：测试网/主网分离、日额度/总额度/单笔上限/域名白名单/审批线/过期时间
- 审批：确认码（给人不给 AI）、10 分钟过期、域名审批、5 次锁死
- 账单：charged yes/no/maybe、链上对账、主网/测试网分离、CSV 导出
- 多级子 key：后端逻辑完整（子 key 永不超父 key、级联撤销），**缺界面**
- 支付：x402 + EIP-3009，Monad 主网/测试网、Base 主网/Sepolia
- 官网已展示「多级子 key、每 agent 一把 key、级联撤销」的叙事（站点停在 v0.5）

### 3.2 新增（云钱包定位的差距，按优先级）
1. **任务备注 / 审计层（最大差距，第一优先级）**
   - 每笔付款带 `task_id`（任务 ID）+ `purpose`（用途说明）+ agent 身份 + 上下文链接
   - Skill 模板要求 AI 在发起请求时上报「这笔钱花给谁、为什么花」（可选：`purpose` 必填开关，管理员可要求「带备注才能付」）
   - 账单页按任务/用途汇总，可导出审计报告（谁、何时、花给谁、干什么、链上交易号）
   - **这是与 Coinbase Agentic Wallet / MetaMask agent wallet / Privy 的差异化点**：别人记「花给谁、花多少」，我们记「为什么花、哪个任务花的」
2. **子 key 自助申请流程**
   - v0.7 子 key 只有后端：补界面 = AI/员工在父 key 额度内**自助申请子 key**，上报任务备注 → 管理员审批 → 发子 key
   - 对应「AI 可以在总余额限制下，为当前任务申请一个 key 或子 key」的设想
3. **云部署体验补完**
   - 余额阈值告警（低余额提醒充值）、异常支出告警、健康检查、一键 Docker + HTTPS + 备份（deploy/ 已有骨架）
   - 「定期给钱包充值」的产品化：热钱包小额 + 充值提醒
4. **多 agent 入驻体验**
   - 一个部署 = 一个组织，组织内多个管理员、多个 agent 池；**不做多租户托管**（见 §7 边界）

### 3.3 验收标准（改写 v0.7 的 10 分钟原则）
> 一个新组织的管理员，10 分钟内在云钱包上给两个 AI 各发一把 key，让其中一个 AI **带着任务备注**付成一笔测试款，账单上能按任务查到这笔的用途和链上交易号。

## 4. 服务端钱包安全：从「助记词」到分层防御

现状：助记词 → 本地加密 keystore + 解锁文件（ACL）。单点风险：**服务器被攻破 = 私钥可被取用**（解锁文件保护的是磁盘，不是进程）。

「定期给钱包充值」的方向**完全正确**，这是第一道、也是性价比最高的一道防线。下面是完整的安全阶梯（从易到难、成本递增）：

| 层级 | 做法 | 解决的问题 | 成本 | 建议 |
|---|---|---|---|---|
| L0 资金分层 | 热钱包只放 1 周预算，定期充值；大头放冷钱包/硬件钱包/交易所 | 服务器被攻破 = 只损失小额 | 零 | **v0.8 必做**（配合余额告警） |
| L1 信封加密 | keystore 用云 KMS（AWS/GCP/Azure）或 OS 钥匙串做信封加密，签名时才取 | 单文件泄露拿不到明文 | 低 | v0.8 可选 |
| L2 KMS 签名 | 私钥直接生成在 KMS 里（支持 secp256k1 ECDSA），服务器只调 Sign API，**私钥永不出 KMS** | 服务器拿不到私钥 | 中；KMS 密钥不可导出，需换新地址 | v0.9 候选 |
| L3 智能合约钱包（Safe） | 钱包 = Safe 多签（2/3：服务器 key + 管理员 key + 备份）；agent 支出走受限 module/session key，**额度在链上强制** | 服务器被完全攻破也只能花 module 允许的额度；审计在链上 | 中高 | **v0.9 首选**（评委最认的叙事） |
| L4 MPC 门限签名 | 2-of-3 分片（服务器 1 片 + 管理员设备 1 片 + 备份 1 片），无完整私钥，2 片才能签 | 服务器单点被攻破无法单独动钱 | 高（自托管 OSS 实现重） | 远期 |
| L5 TEE 签名 | 签名在 enclave 内（Coinbase Agentic Wallets 的做法） | 强隔离 | 很高 | 远期/参考 |

**推荐路线**：v0.8 = L0（热钱包小额 + 定期充值 + 余额告警）+ 可选 L1；v0.9 = L3（Safe 智能账户，链上策略 + 链上审计）；MPC/TEE 作为后续叙事。

**免 gas 方案（按适用性排序）**：
1. **x402 本身已免 gas**：付款方只签 EIP-3009 授权，交易由收款方/facilitator 提交并付 gas（现网已在跑：官网写「A facilitator settles the transfer and pays the gas」）——**付款方不需要任何 native token**。
2. **ERC-4337 智能账户 + Paymaster**：Circle Paymaster 支持用 USDC 付 gas（Base/Arbitrum 等已上线），适合钱包侧自己做链上动作（充值、授权）时免 gas。
3. **链原生低 gas**：Monad/Base 的 gas 都很便宜，需要时留一点点 native token 即可，不是痛点。
4. 充值本身由转出方（管理员/交易所/冷钱包）付 gas，云钱包侧无感。

## 5. 竞品位置：云钱包赛道现状

| 方案 | 形态 | 自托管 | 任务级审计 | x402 原生 | 备注 |
|---|---|---|---|---|---|
| Coinbase Agentic Wallet | SaaS（CDP 智能钱包 + TEE 内策略） | 否 | 无 | 是 | 2026-02 上线，最重的玩家 |
| MetaMask agent wallet | 非托管嵌入式 | 否 | 无 | 是 | 2026-09 发布，方向印证 |
| Safe / AgentSafe | 智能账户 + 模块 | 可 | 无 | 需自接 | 链上策略强 |
| Privy | 服务器钱包（Nitro enclave + Shamir） | 否 | 无 | 仅授权环节 | 被 Stripe 收购 |
| Turnkey | enclave 签名 API + policy engine | 否 | 无 | 不原生 | 25 sigs/月免费 |
| Crossmint | 模块化 signer + 支付层 | 否 | 无 | 是 | 50+ 链 |
| Openfort/thirdweb 等 | agent wallet SDK | 部分 | 无 | 部分 | 框架类 |
| **MoneySwitch（目标）** | **自托管服务器 + MoneyKey** | **是** | **有（任务备注）** | **是（EIP-3009）** | **唯一「自托管 + 任务审计 + x402」** |

结论：赛道不空，但**「可云自托管 + 任务级审计 + x402 原生」这个组合目前没人占**。大玩家全是 SaaS/嵌入式托管；Safe 类有链上策略但没有「给 agent 发 key + 记任务 + 审计」的产品层。MoneySwitch 的差异化 = 自托管（数据/私钥/策略全在自己手里）+ 任务审计（AI 花钱的可解释性）。

## 6. 品牌与叙事建议

- **云钱包**（Cloud Wallet for AI Agents）= 产品品类词
- **MoneyKey** = 给 AI 的「花钱 API key」（已有，保留）
- 一句话：*Model keys give AI a brain. MoneyKeys give it a wallet. Now with receipts — every spend carries a task and a reason.*
- 隐喻：MoneySwitch 是「所有 AI 的 CFO」——管预算、批大额、查账；AI 是「持卡员工」——额度内自付、每笔留理由。

## 7. 边界与风险（写进 SPEC §8）

- **不做多租户托管**：一个部署 = 一个组织；替陌生人管钱 = 托管 = 牌照问题（延续 v0.7 的合规姿态）。
- **任务备注是 AI 自报的**，可能被 prompt injection 伪造：备注只作审计线索，不作信任凭据；真实凭据 = 链上交易 + key 归属 + 审批记录。UI 上标注「用途为 AI 自报」。
- **与 SaaS 大厂不正面竞争**：目标用户是自托管者、开发者、小团队、需要「钱在自己手里」的组织。
- 现在不做（沿用 v0.7）：员工门户大而全、推送渠道、模型网关、MCP、导入钱包、法币出入金、swap、跨链。

## 来源

- x402 白皮书（Coinbase）：https://x402.org/wp-content/uploads/sites/10/2026/06/x402-whitepaper.pdf
- x402 机制（ethereum.org / Aptos / Cardano 术语表）：https://www.ethereum.org/developers/tools/x402/ · https://aptosnetwork.com/currents/what-is-x402-the-payment-protocol-for-ai-agents-on-aptos · https://cardano.org/ja/glossary/x402/
- Agentic commerce map（Edge&Node，含 MetaMask agent 支付）：https://www.edgeandnode.com/agentic-commerce-map
- MetaMask 面向 AI agent 的非托管钱包（链捕手 2026-09-19）：https://www.chaincatcher.com/tags/%E4%BB%A3%E7%90%86%E6%94%AF%E4%BB%98
- 服务端签名架构对比（Para）：https://blog.getpara.com/comparing-backend-transaction-signing-architectures/
- MPC vs 多签 vs HSM（thesignal.directory）：https://thesignal.directory/intelligence/crypto-custody-solutions-mpc-multisig-hsm-2026
- HSM 密钥管理（BlockSec）：https://blocksec.com/blog/crypto-payment-key-management
- Agent wallet 对比（Openfort / Crossmint / Alchemy）：https://www.openfort.io/blog/best-agent-wallets-for-developers · https://www.crossmint.com/learn/agent-wallets-compared · https://www.alchemy.com/overviews/best-infrastructure-for-agentic-payments
- Coinbase Agentic Wallets（Crossmint / Spark 调研）：https://www.crossmint.com/learn/agent-wallets-compared · https://www.spark.money/research/agentic-payments-stablecoin-infrastructure
- Circle Paymaster（用 USDC 付 gas）：https://www.circle.com/blog/introducing-circle-paymaster · https://developers.circle.com/stablecoins/paymaster-overview
- ERC-4337 / paymaster 机制：https://docs.erc4337.io/core-standards/erc-4337
- MoneySwitch 官网（v0.5 叙事、facilitator 付 gas、多级子 key）：https://moneyswitch.dev/
