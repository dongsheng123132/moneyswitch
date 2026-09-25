import { defineMessages } from "../index";

/** Copy for the Approvals page (docs/ux-audit.md D-3, B-3). */
export const approvalsStrings = defineMessages(
  {
    introTitle: "How approvals work",
    introBody:
      "Payments at or above a key's approval threshold pause here. After you approve, the agent (or Playground) re-sends the request with the approval id to complete it. Requests you don't handle in time expire.",

    chatViaHost: "Chat via {host}",
    payTo: "pay to {addr}",
    countdownLeft: "{m}m {s}s left",
    countdownExpired: "expired",

    keyContextUsed: "{used} / {daily} used today",
    keyContextThreshold: "Approval threshold",
    keyContextPerRequest: "Per-request limit",

    approve: "Approve",
    deny: "Deny",
    successApproved: "Approved — the agent can now retry.",
    successDenied: "Denied.",

    emptyTitle: "Nothing waiting",
    emptyBody: "Payments that hit a key's approval threshold will show up here for you to approve or deny.",
    emptyAction: "Manage keys",

    recentDecidedTitle: "Recently decided",
    statusApproved: "Approved",
    statusDenied: "Denied",
    statusExpired: "Expired",
    statusUsed: "Used",
  },
  {
    introTitle: "审批是怎么回事",
    introBody:
      "单笔金额达到这把 Key 的审批阈值时会先暂停在这里。你批准之后，Agent（或 Playground）会带着审批编号重新发起请求来完成付款；没有及时处理的请求会自动过期。",

    chatViaHost: "通过 {host} 对话",
    payTo: "付给 {addr}",
    countdownLeft: "剩 {m} 分 {s} 秒",
    countdownExpired: "已过期",

    keyContextUsed: "今日已用 {used} / {daily}",
    keyContextThreshold: "审批阈值",
    keyContextPerRequest: "单笔上限",

    approve: "批准",
    deny: "拒绝",
    successApproved: "已批准 —— Agent 现在可以重试了。",
    successDenied: "已拒绝。",

    emptyTitle: "暂无待处理",
    emptyBody: "当某把 Key 的单笔付款达到审批阈值时，会出现在这里等你批准或拒绝。",
    emptyAction: "管理 Key",

    recentDecidedTitle: "最近已处理",
    statusApproved: "已批准",
    statusDenied: "已拒绝",
    statusExpired: "已过期",
    statusUsed: "已使用",
  }
);
