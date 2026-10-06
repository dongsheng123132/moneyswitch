import { defineMessages } from "../index";

/** Copy for the Approvals page (SPEC.md §3). */
export const approvalsStrings = defineMessages(
  {
    introTitle: "How approvals work",
    introBody:
      "Payments at or above a key's approval threshold pause here, and the AI sends a link to the person who holds the key: they open it and approve or deny with the key's confirmation code, no login. You, the administrator, can approve everything here. After approval, the AI sends the request again with the approval id and the payment goes through. A request to a host that is not on the key's list pauses here too: approving it adds that host to the key from now on, and the AI sends the request again as it was. Requests you don't handle within 10 minutes expire.",

    payTo: "pay to {addr}",
    hostBadge: "New host",
    hostSource: "Requested:",
    hostNote: "Once approved, this key can reach {host} from now on. The price is only known when the seller quotes it; the key's limits are still checked.",
    errHostPrivate: "Not approved: this host is, or resolves to, a private, loopback or special-use address, or one of this machine's own. Only a host written when the key was issued can be allowed that way. The request stays pending.",
    errHostUnresolved: "Not approved: the host's address could not be looked up (it failed or took longer than 3 seconds), so nothing was added. The request stays pending: try Approve again, or Deny.",
    countdownLeft: "{m}m {s}s left",
    countdownExpired: "expired",

    keyContextUsed: "{used} / {daily} used today",
    keyContextThreshold: "Approval threshold",
    keyContextPerRequest: "Per-request limit",

    approve: "Approve",
    deny: "Deny",
    successApproved: "Approved — the AI can now resend its request.",
    successDenied: "Denied.",

    emptyTitle: "Nothing waiting",
    emptyBody: "Payments that hit a key's approval threshold, and requests to a host outside a key's list, will show up here for you to approve or deny.",
    emptyAction: "Manage keys",

    linkedTitle: "This is the request your AI linked to",
    linkedAlready: "It was already handled: {status}.",
    linkedNotFound: "No request with that id was found. It may be from another MoneySwitch server, or very old.",

    // The approval link for the person who holds the key (SPEC.md §3): no login, the key's PIN decides
    linkLead: "Your AI is waiting for this approval. Check what it asks for, then type the confirmation code for this key to approve or deny it.",
    pinLabel: "Confirmation code (PIN)",
    pinPlaceholder: "4–6 digits",
    pinHint: "The administrator set it for this key. It decides this one request only; your AI never has it.",
    pinWrong: "That confirmation code is not right. {n} tries left before it locks.",
    pinLocked: "This key's confirmation code is locked after 5 wrong tries. Ask the administrator to approve this, or to set a new confirmation code for the key.",
    pinWarning: "Do not tell the AI the confirmation code, and do not paste it into a chat. Type it only on this page.",
    pinOrigin: "Current address: {origin}",
    pinFailures: "Wrong tries so far: {n} ({max} lock it)",
    pinNotSet: "This key has no confirmation code yet, so only the administrator can approve its requests. Ask the administrator to approve this, or to set a code for the key.",
    pinFormat: "The confirmation code is 4 to 6 digits.",
    keyNotActive: "The key this request belongs to was revoked or has expired: nothing can be approved for it.",
    alreadyHandled: "This request was already handled, or has expired.",
    adminSignIn: "Administrator? Sign in",

    recentDecidedTitle: "Recently decided",
    statusApproved: "Approved",
    statusDenied: "Denied",
    statusExpired: "Expired",
    statusUsed: "Used",
  },
  {
    introTitle: "审批是怎么回事",
    introBody:
      "单笔金额达到这把 Key 的审批阈值时会先暂停在这里，AI 会把链接发给持这把 Key 的人：他打开链接、输入这把 Key 的确认码就能批准或拒绝，不用登录；你作为管理员可以在这里批全部。批准之后，AI 会带着审批编号重新发起请求，付款随之完成。请求的域名不在这把 Key 的允许列表里时也会先停在这里：批准就是把这个域名加进这把 Key 的允许列表，AI 原样重发即可；10 分钟内没有处理的请求会自动过期。",

    payTo: "付给 {addr}",
    hostBadge: "新域名",
    hostSource: "来源网址：",
    hostNote: "批准后，这把 key 以后都可以访问 {host}；价格要等卖家报价，额度照常检查。",
    errHostPrivate: "未批准：这个域名本身是、或解析到私有 / 本机 / 特殊用途地址。只有发 key 时写上的域名才能这样放行。这条请求仍在待批。",
    errHostUnresolved: "未批准：查不到这个域名的地址（查询失败或超过 3 秒），所以什么都没有加。这条请求仍在待批：可以再点一次批准，或拒绝。",
    countdownLeft: "剩 {m} 分 {s} 秒",
    countdownExpired: "已过期",

    keyContextUsed: "今日已用 {used} / {daily}",
    keyContextThreshold: "审批阈值",
    keyContextPerRequest: "单笔上限",

    approve: "批准",
    deny: "拒绝",
    successApproved: "已批准 —— AI 现在可以重新发起请求了。",
    successDenied: "已拒绝。",

    emptyTitle: "暂无待处理",
    emptyBody: "当某把 Key 的单笔付款达到审批阈值，或请求的域名不在某把 Key 的允许列表里时，会出现在这里等你批准或拒绝。",
    emptyAction: "管理 Key",

    linkedTitle: "这就是你的 AI 发来链接的那一笔",
    linkedAlready: "它已经处理过了：{status}。",
    linkedNotFound: "找不到这个编号的请求。它可能来自另一台 MoneySwitch 服务器，或者已经很久了。",

    // 持 key 的人用的审批链接（SPEC.md §3）：不用登录，输入这把 key 的确认码
    linkLead: "你的 AI 在等这条审批。看清它要什么，再输入这把 key 的确认码来批准或拒绝。",
    pinLabel: "确认码",
    pinPlaceholder: "4–6 位数字",
    pinHint: "管理员给这把 key 设的。它只决定这一条请求；你的 AI 拿不到它。",
    pinWrong: "确认码不对。再错 {n} 次就会锁住。",
    pinLocked: "这把 key 的确认码已累计输错 5 次，已锁住。请让管理员来批准这条，或为这把 key 重新设置确认码。",
    pinWarning: "不要把确认码告诉 AI，也不要贴进聊天；只在这个页面输入。",
    pinOrigin: "当前网址：{origin}",
    pinFailures: "已输错 {n} 次（{max} 次锁定）",
    pinNotSet: "这把 key 还没有确认码，所以只有管理员能批准它的请求。请让管理员来批准这条，或为这把 key 设置确认码。",
    pinFormat: "确认码是 4 到 6 位数字。",
    keyNotActive: "这条请求所属的 key 已被撤销或已过期：什么都批不了。",
    alreadyHandled: "这条请求已经处理过了，或已过期。",
    adminSignIn: "我是管理员，去登录",

    recentDecidedTitle: "最近已处理",
    statusApproved: "已批准",
    statusDenied: "已拒绝",
    statusExpired: "已过期",
    statusUsed: "已使用",
  }
);
