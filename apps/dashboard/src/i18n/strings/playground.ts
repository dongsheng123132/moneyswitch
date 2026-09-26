import { defineMessages } from "../index";

/** Copy for PlaygroundChat (shared admin + employee) and PlaygroundPage. docs/ux-audit.md B-3, D-6. */
export const playgroundStrings = defineMessages(
  {
    keyPlaceholder: "mk_live_… (stored only in this browser tab)",
    loadModels: "Load models",
    loading: "Loading...",
    noModelsYet: "No models loaded",
    emptyHint: "Paste a Money Key, load models, and start chatting. Every message is a real x402 payment.",
    inputAriaLabel: "Message the model",
    inputPlaceholder: "Message the model — Enter to send, Shift+Enter for newline",
    send: "Send",
    pasteKeyFirst: "Paste a Money Key first.",
    pickModelFirst: "Pick a model first.",

    // Approval bubble
    approvalNeeded: "Needs approval",
    approvalId: "Approval {id}",
    approvalWaitingEmployee: "Sent to your admin for approval — once approved, press Continue.",
    approvalWaitingAdmin: "Approve it on the Approvals page, then press Continue.",
    goApprovals: "Go to Approvals",
    continueBtn: "Continue",
    stillWaiting: "Still waiting for approval.",

    // Assistant meta
    tokensLabel: "{n} tokens",

    // Errors (friendly sentence shown above a small raw code line)
    rawCodeLine: "code: {code}",
    err_dailyBudget: "Today's budget is used up — it resets at 00:00 UTC (08:00 Beijing time).",
    err_totalBudget: "This key's lifetime budget is used up. Ask your admin to issue a new key or raise the total.",
    err_perRequest: "That request costs more than this key's per-request limit allows.",
    err_rateLimited: "Too many payments in a short time — wait a moment and try again.",
    err_keyRevoked: "This key has been revoked and can no longer be used.",
    err_keyExpired: "This key has expired.",
    err_keyInvalid: "This key isn't valid — check you copied it in full.",
    err_walletLockedEmployee: "The admin's wallet is locked — ask the admin to unlock it before payments can go through.",
    err_walletLockedAdmin: "The wallet is locked — unlock it on the Wallet page, then try again.",
    err_modelNotAllowed: "This key isn't allowed to use that model.",
    err_modelNotFound: "That model isn't available from any enabled channel.",
    err_paymentFailed: "The payment didn't go through — nothing was charged.",
    err_upstreamError: "The upstream model provider returned an error.",
    err_network: "Could not reach the MoneySwitch server — check your connection and try again.",
    err_generic: "Something went wrong.",
    walletPageLink: "Wallet page",
    // SPEC-v0.4.md §A: a denial on a child key may actually be an ancestor's
    // limit tripping, not this key's own.
    limitScopeAncestorHint: " (limit set by parent key {prefix})",

    // Right panel (PlaygroundPage)
    keyStatusTitle: "Key status",
    pasteKnownKey: "Paste a known Money Key above to see live budget.",
    todayUsedLimit: "Today used / daily limit",
    perRequestLimit: "Per request",
    approvalThresholdLabel: "Approval ≥",
    approvalThresholdNone: "—",
    emptyKeyTitle: "No key loaded yet",
    emptyKeyBody: "Keys are shown only once, at creation. Create one on Money Keys and press \"Try it in Playground\" to land here with it filled in.",
    goToKeys: "Go to Money Keys",
  },
  {
    keyPlaceholder: "mk_live_…（只存在这个浏览器标签页里）",
    loadModels: "刷新模型",
    loading: "加载中…",
    noModelsYet: "暂无可用模型",
    emptyHint: "粘贴一把 Money Key，加载模型后就能开始对话 —— 每条消息都是一次真实的 x402 付款。",
    inputAriaLabel: "给模型发消息",
    inputPlaceholder: "输入消息 — Enter 发送，Shift+Enter 换行",
    send: "发送",
    pasteKeyFirst: "请先粘贴一把 Money Key。",
    pickModelFirst: "请先选择一个模型。",

    approvalNeeded: "需要审批",
    approvalId: "审批编号 {id}",
    approvalWaitingEmployee: "已提交给管理员审批 —— 批准后点这里继续。",
    approvalWaitingAdmin: "去「审批」页批准后，点这里继续。",
    goApprovals: "去审批页",
    continueBtn: "继续",
    stillWaiting: "还在等待审批。",

    tokensLabel: "{n} tokens",

    rawCodeLine: "错误码：{code}",
    err_dailyBudget: "今天的额度已用完，UTC 0 点（北京时间 8 点）恢复。",
    err_totalBudget: "这把 Key 的累计额度已用完，请让管理员重发一把或提高总额度。",
    err_perRequest: "这次请求的花费超过了这把 Key 的单次上限。",
    err_rateLimited: "短时间内付款太频繁，请稍等再试。",
    err_keyRevoked: "这把 Key 已被撤销，不能再使用。",
    err_keyExpired: "这把 Key 已过期。",
    err_keyInvalid: "这把 Key 无效，请检查是否复制完整。",
    err_walletLockedEmployee: "管理员的钱包已锁定 —— 请联系管理员解锁后再试。",
    err_walletLockedAdmin: "钱包已锁定 —— 去「钱包」页解锁后再试。",
    err_modelNotAllowed: "这把 Key 不允许使用这个模型。",
    err_modelNotFound: "所有已启用的渠道里都没有这个模型。",
    err_paymentFailed: "付款没有成功，没有扣除额度。",
    err_upstreamError: "上游模型服务返回了错误。",
    err_network: "连不上 MoneySwitch 服务器，请检查网络后重试。",
    err_generic: "出了点问题。",
    walletPageLink: "钱包页",
    limitScopeAncestorHint: "（上级 Key {prefix} 的额度）",

    keyStatusTitle: "Key 状态",
    pasteKnownKey: "在上面粘贴一把已知的 Money Key，就能看到实时额度。",
    todayUsedLimit: "今日已用 / 每日限额",
    perRequestLimit: "单次上限",
    approvalThresholdLabel: "审批线 ≥",
    approvalThresholdNone: "—",
    emptyKeyTitle: "还没有加载 Key",
    emptyKeyBody: "Key 只会在创建时显示一次。去「Money Keys」新建一把，点「在 Playground 里试试」，就会带着 Key 跳回这里。",
    goToKeys: "去 Money Keys",
  }
);
