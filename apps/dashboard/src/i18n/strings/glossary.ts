import { defineMessages } from "../index";

/**
 * Plain-language explanations shown by <Term> on hover/focus
 * (docs/ux-audit.md X-1). Keep each one to 1–2 sentences.
 */
export const glossary = defineMessages(
  {
    moneyKey:
      "An API key for money (mk_live_…). You give it to an agent instead of a wallet private key; every payment it triggers is checked against this key's limits first.",
    dailyBudget: "The most this agent can spend per UTC day. Payments beyond it are refused until 00:00 UTC.",
    totalBudget: "Lifetime cap for this key. Once reached, the key stops paying until you raise it by issuing a new key.",
    perRequestLimit: "The largest single payment this key may make. A pricier request is refused outright — it never reaches approval.",
    approvalThreshold:
      "Payments at or above this amount pause and wait for you on the Approvals page, every time. Leave empty to never ask.",
    allowedHosts:
      "Sites (host:port) this key may pay without asking. Any other site asks you once through an approval link; approving adds it here.",
    rateLimit: "Maximum number of payments per minute, to stop a looping agent from draining the budget.",
    expiresAt: "After this date the key stops working. Empty = never expires.",
    subtreeUsage:
      "\"Today\" / \"Total used\" here include this key's own spending PLUS everything its sub-keys have spent — that is what counts against this key's own budget.",
    ancestorRevoked: "This key itself is still enabled, but a parent key above it was revoked — so it stops working too, immediately.",
    ancestorExpired: "This key itself hasn't expired, but a parent key above it has — so it stops working too.",
  },
  {
    moneyKey: "一把「花钱的 API Key」（mk_live_…）。给 Agent 的是它，而不是钱包私钥；它触发的每一笔付款都要先过这把 Key 的额度规则。",
    dailyBudget: "这个 Agent 每个 UTC 自然日最多能花多少。超出后当天的付款都会被拒绝，UTC 0 点（北京时间 8 点）恢复。",
    totalBudget: "这把 Key 累计最多能花多少。花完后这把 Key 不能再付款，需要重新发一把。",
    perRequestLimit: "单笔付款的上限。比它贵的请求直接拒绝，不会进入审批。",
    approvalThreshold: "单笔达到这个金额就先暂停，等你在「审批」页批准后才付款——每一笔都问。留空 = 从不需要审批。",
    allowedHosts:
      "这把 Key 不用问就能付款的网站（host:port）。其他网站会先发批准链接问你一次，批准后自动加进来。",
    rateLimit: "每分钟最多付款几次，防止 Agent 死循环把额度刷光。",
    expiresAt: "过了这个日期 Key 自动失效。留空 = 永不过期。",
    subtreeUsage: "这里的「今日」「累计已用」= 这把 Key 自己的花费 + 它所有子 Key 的花费之和 —— 这才是真正会计入这把 Key 额度的数字。",
    ancestorRevoked: "这把 Key 本身没有被撤销，但它的上级 Key 被撤销了，所以它也立刻不能用了。",
    ancestorExpired: "这把 Key 本身没有过期，但它的上级 Key 过期了，所以它也不能用了。",
  }
);
