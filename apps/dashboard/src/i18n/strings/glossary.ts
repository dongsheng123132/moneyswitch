import { defineMessages } from "../index";

/**
 * Plain-language explanations shown by <Term> on hover/focus
 * (docs/ux-audit.md X-1). Keep each one to 1–2 sentences.
 */
export const glossary = defineMessages(
  {
    moneyKey:
      "An API key for money (mk_live_…). You give it to an agent instead of a wallet private key; every payment it triggers is checked against this key's limits first.",
    adminToken:
      "The admin credential (ms_admin_…) for this console. It is stored only as a hash — keep your own copy. Lost it? Run `pnpm admin:reset-token`.",
    dailyBudget: "The most this agent can spend per UTC day. Payments beyond it are refused until 00:00 UTC.",
    totalBudget: "Lifetime cap for this key. Once reached, the key stops paying until you raise it by issuing a new key.",
    perRequestLimit: "The largest single payment this key may make. A pricier request is refused outright — it never reaches approval.",
    approvalThreshold:
      "Payments at or above this amount pause and wait for you on the Approvals page. Leave empty to never ask.",
    allowedHosts:
      "Hosts (host:port) this key may call through paid fetch (MCP paid_fetch / REST /v1/fetch). Chat through a channel is always allowed for that channel's host. Empty = nothing allowed.",
    allowedModels: "Which channel models this key may chat with. Empty = every model of every enabled channel.",
    rateLimit: "Maximum number of payments per minute, to stop a looping agent from draining the budget.",
    expiresAt: "After this date the key stops working. Empty = never expires.",
    x402: "An open HTTP payment protocol: a paid endpoint answers 402 with a price, the client signs a USDC authorization and retries. MoneySwitch does the signing — only after your limits pass.",
    facilitator:
      "The service that settles a signed x402 payment on-chain and pays the gas. In the offline demo a mock facilitator pretends to settle (no real transfer).",
    channel:
      "An OpenAI-compatible upstream that charges per call over x402. When an agent chats through MoneySwitch, the model name picks the channel and MoneySwitch pays it.",
    usdc: "A dollar-pegged stablecoin. MoneySwitch pays in test USDC on Monad testnet; 1 USDC ≈ $1.",
    wallet:
      "The server-side wallet that actually signs payments. Agents never see its private key. Keep only a small balance in it.",
    walletLocked:
      "After a restart the wallet key stays encrypted until you unlock it with its password (or set MONEYSWITCH_WALLET_PASSWORD). While locked every payment fails with WALLET_LOCKED.",
    status_settled: "Paid and confirmed by the facilitator.",
    status_reserved: "Budget reserved, payment in flight.",
    status_failed: "Payment did not go through; nothing was charged against the budget.",
    status_unknown:
      "The upstream result could not be determined (timeout/disconnect). It is conservatively counted as spent — check it on the explorer.",
    mock: "Settled by the offline mock facilitator: no real on-chain transfer happened.",
  },
  {
    moneyKey: "一把「花钱的 API Key」（mk_live_…）。给 Agent 的是它，而不是钱包私钥；它触发的每一笔付款都要先过这把 Key 的额度规则。",
    adminToken: "这个控制台的管理员凭据（ms_admin_…）。服务器只存哈希，请自己保存一份。丢了可以运行 `pnpm admin:reset-token` 重置。",
    dailyBudget: "这个 Agent 每个 UTC 自然日最多能花多少。超出后当天的付款都会被拒绝，UTC 0 点（北京时间 8 点）恢复。",
    totalBudget: "这把 Key 累计最多能花多少。花完后这把 Key 不能再付款，需要重新发一把。",
    perRequestLimit: "单笔付款的上限。比它贵的请求直接拒绝，不会进入审批。",
    approvalThreshold: "单笔达到这个金额就先暂停，等你在「审批」页批准后才付款。留空 = 从不需要审批。",
    allowedHosts:
      "这把 Key 通过付费调用（MCP 的 paid_fetch / REST 的 /v1/fetch）能访问哪些地址（host:port）。通过渠道对话时，渠道自己的地址自动放行。留空 = 全部拒绝。",
    allowedModels: "这把 Key 可以用哪些渠道模型对话。留空 = 所有已启用渠道的所有模型。",
    rateLimit: "每分钟最多付款几次，防止 Agent 死循环把额度刷光。",
    expiresAt: "过了这个日期 Key 自动失效。留空 = 永不过期。",
    x402: "一个开放的 HTTP 付费协议：收费接口先返回 402 和价格，客户端签一张 USDC 授权后重试。签名由 MoneySwitch 在额度检查通过之后完成。",
    facilitator: "负责把签好的 x402 付款真正上链结算、并代付 gas 的服务。离线 demo 里用的是 mock facilitator，只模拟结算，没有真实转账。",
    channel: "按次收费（x402）的 OpenAI 兼容上游。Agent 通过 MoneySwitch 对话时，按模型名选渠道，由 MoneySwitch 付钱。",
    usdc: "与美元 1:1 锚定的稳定币。MoneySwitch 在 Monad 测试网上用测试 USDC 付款；1 USDC ≈ 1 美元。",
    wallet: "服务器上真正签名付款的钱包，Agent 永远拿不到它的私钥。里面只放少量余额。",
    walletLocked: "服务重启后，钱包私钥保持加密状态，直到你用密码解锁（或设置 MONEYSWITCH_WALLET_PASSWORD）。锁定期间所有付款都会报 WALLET_LOCKED。",
    status_settled: "已付款，facilitator 已确认。",
    status_reserved: "额度已预占，付款进行中。",
    status_failed: "付款没有成功，不占用额度。",
    status_unknown: "上游结果无法确定（超时/断连），为了不超支按「已花」计入额度，请到链上浏览器核对。",
    mock: "由离线 mock facilitator 模拟结算，没有真实链上转账。",
  }
);
