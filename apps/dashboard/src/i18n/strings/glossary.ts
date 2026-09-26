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
    canDelegate:
      "This key's holder may create their own sub-keys (child MoneyKeys). A sub-key can never exceed its parent's limits, and revoking the parent disables every sub-key beneath it.",
    subtreeUsage:
      "\"Today\" / \"Total used\" here include this key's own spending PLUS everything its sub-keys have spent — that is what counts against this key's own budget.",
    ancestorRevoked: "This key itself is still enabled, but a parent key above it was revoked — so it stops working too, immediately.",
    ancestorExpired: "This key itself hasn't expired, but a parent key above it has — so it stops working too.",
    tollbooth: "A public address (<server>/t/<slug>) that sits in front of one of your APIs. Anyone can call it; MoneySwitch only forwards the request after it's paid in USDC.",
    payTo: "The address that receives the money for this toll booth — it can be your MoneySwitch wallet or any other address you own.",
    upstream: "The real service the toll booth protects — the address MoneySwitch forwards paid requests to.",
    pricingRule: "One line of \"who pays what\": a method + path pattern + a USDC price. The most specific rule wins when several could match.",
    defaultPrice: "What happens to a request that matches none of your rules: a price to charge, free pass-through, or refuse it outright.",
    settleOnlyOnSuccess: "The buyer is only charged when your service answers success (2xx/3xx). If it errors or times out, nothing is charged.",
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
    canDelegate: "这把 Key 的持有人可以再往下切子 Key。子 Key 的额度永远不能超过这把 Key；这把 Key 一旦被撤销，它所有的子 Key 也会立即失效。",
    subtreeUsage: "这里的「今日」「累计已用」= 这把 Key 自己的花费 + 它所有子 Key 的花费之和 —— 这才是真正会计入这把 Key 额度的数字。",
    ancestorRevoked: "这把 Key 本身没有被撤销，但它的上级 Key 被撤销了，所以它也立刻不能用了。",
    ancestorExpired: "这把 Key 本身没有过期，但它的上级 Key 过期了，所以它也不能用了。",
    tollbooth: "一个公开地址（<服务器>/t/<后缀>），挂在你的某个 API 前面。任何人都能调用它，付了 USDC 之后 MoneySwitch 才会转发这个请求。",
    payTo: "这个收费站收到的钱进的地址——可以是你的 MoneySwitch 钱包，也可以是你自己的任意地址。",
    upstream: "收费站保护的真正服务——付款通过之后 MoneySwitch 会把请求转发到这个地址。",
    pricingRule: "一条「谁、什么路径、收多少钱」的规则：方法 + 路径模式 + USDC 价格。多条规则都能匹配时，最具体的那条生效。",
    defaultPrice: "没有匹配到任何规则的请求怎么处理：按一个价格收费、免费放行，或者直接拒绝。",
    settleOnlyOnSuccess: "只有你的服务返回成功（2xx/3xx）才会扣买家的钱；出错或超时都不收费。",
  }
);
