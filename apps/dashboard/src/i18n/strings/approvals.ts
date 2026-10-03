import { defineMessages } from "../index";

/** Copy for the Approvals page (SPEC.md §3). */
export const approvalsStrings = defineMessages(
  {
    introTitle: "How approvals work",
    introBody:
      "Payments at or above a key's approval threshold pause here and your AI sends you a link to this page. After you approve, the AI sends the request again with the approval id and the payment goes through. Requests you don't handle within 10 minutes expire.",

    payTo: "pay to {addr}",
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
    emptyBody: "Payments that hit a key's approval threshold will show up here for you to approve or deny.",
    emptyAction: "Manage keys",

    linkedTitle: "This is the request your AI linked to",
    linkedAlready: "It was already handled: {status}.",
    linkedNotFound: "No request with that id was found. It may be from another MoneySwitch server, or very old.",

    recentDecidedTitle: "Recently decided",
    statusApproved: "Approved",
    statusDenied: "Denied",
    statusExpired: "Expired",
    statusUsed: "Used",
  },
  {
    introTitle: "审批是怎么回事",
    introBody:
      "单笔金额达到这把 Key 的审批阈值时会先暂停在这里，你的 AI 会把指向本页的链接发给你。你批准之后，AI 会带着审批编号重新发起请求，付款随之完成；10 分钟内没有处理的请求会自动过期。",

    payTo: "付给 {addr}",
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
    emptyBody: "当某把 Key 的单笔付款达到审批阈值时，会出现在这里等你批准或拒绝。",
    emptyAction: "管理 Key",

    linkedTitle: "这就是你的 AI 发来链接的那一笔",
    linkedAlready: "它已经处理过了：{status}。",
    linkedNotFound: "找不到这个编号的请求。它可能来自另一台 MoneySwitch 服务器，或者已经很久了。",

    recentDecidedTitle: "最近已处理",
    statusApproved: "已批准",
    statusDenied: "已拒绝",
    statusExpired: "已过期",
    statusUsed: "已使用",
  }
);
