import { defineMessages } from "../index";

/**
 * Copy for the employee "My sub-keys" page (SPEC-v0.4.md §A Dashboard,
 * src/pages/employee/MySubKeysPage.tsx). Own file since it's a whole new
 * page rather than an extension of an existing one.
 */
export const subkeysStrings = defineMessages(
  {
    pageTitle: "My sub-keys",
    pageIntro: "Cut a sub-key for each of your agents. A sub-key can never spend more than your own key allows, and you can revoke any of them instantly.",

    headerRemainingToday: "My remaining today",
    headerRemainingTotal: "My remaining total",
    headerCanDelegateYes: "You can create sub-keys.",
    headerCanDelegateNo: "You can't create sub-keys — ask your admin to turn on delegation for your key.",
    headerMaxDepthReached: "You can't create sub-keys — the maximum delegation depth ({depth}) has been reached.",

    createBtn: "Create sub-key",
    drawerTitleCreate: "Create a sub-key",
    drawerTitleCreated: "Sub-key created",

    nameLabel: "Who / what is this sub-key for",
    namePlaceholder: "e.g. My local Claude Code",
    lblDaily: "Daily budget",
    lblPerReq: "Per-request limit",
    lblTotal: "Total budget",
    lblThreshold: "Approval threshold (optional)",
    thresholdHint: "Leave empty to inherit mine.",
    thresholdHintWithValue: "Leave empty to inherit mine: payments of {value} or more need the admin's approval. Can't be set higher than that.",
    maxHintDaily: "Max {limit} (your daily budget). You have {remaining} left today — sub-keys spend from it.",
    maxHintPerReq: "Max {limit} (your per-request limit).",
    maxHintTotal: "Max {limit} (your total budget). You have {remaining} left in total.",
    shareNote: "How limits work: every sub-key's spending also counts against your own key (and any key above yours). Sub-key budgets may add up to more than yours, but together they can never spend more than you have left. Revoking your key — or a key above it — disables all your sub-keys.",
    remainingBoundByParent: "Limited by a key above yours",
    canDelegateLabel: "Allow this sub-key to create its own sub-keys",
    canDelegateUnavailable: "Not available: creating one more level would exceed the maximum delegation depth.",

    errRequired: "Required.",
    errDecimal: "Enter a number greater than 0 with up to 6 decimals.",
    errExceedsMineDaily: "Cannot exceed your own daily budget ({value}).",
    errExceedsMinePerReq: "Cannot exceed your own per-request limit ({value}).",
    errExceedsMineTotal: "Cannot exceed your own total budget ({value}).",
    submitBtn: "Create sub-key",
    submitting: "Creating…",

    // Server error surfacing (SPEC-v0.4.md §A: CHILD_EXCEEDS_PARENT etc.)
    errFieldExceedsParent: "{field} cannot exceed your own: {value}",
    errFieldInvalid: "{field} is invalid: {message}",
    errThresholdOverPerReq: "Must not be higher than this sub-key's per-request limit.",
    errDelegationNotAllowed: "You aren't allowed to create sub-keys.",
    errMaxDepthExceeded: "Maximum delegation depth reached — this sub-key couldn't create further sub-keys of its own.",
    errChildrenLimitReached: "You've reached the limit on how many sub-keys you can have.",

    field_name: "Name",
    field_daily_budget: "Daily budget",
    field_total_budget: "Total budget",
    field_per_request_limit: "Per-request limit",
    field_approval_threshold: "Approval threshold",
    field_allowed_hosts: "Allowed hosts",
    field_expires_at: "Expires at",
    field_can_delegate: "Allow sub-keys",
    field_max_payments_per_minute: "Max payments / minute",

    createdBanner: "This is the only time the full key is shown. Copy it now.",
    keyFieldLabel: "Sub-key",

    listTitle: "My sub-keys",
    colName: "Name",
    colKeyPrefix: "Key",
    colToday: "Today",
    colPerRequest: "Per request",
    colTotal: "Total used / budget",
    colStatus: "Status",
    colActions: "",

    emptyTitle: "No sub-keys yet",
    emptyBody: "Cut a sub-key for each agent you run — each one gets its own limits, carved out of yours.",

    revokeBtn: "Revoke",
    revokeConfirmText: "Revoke this sub-key? The agent using it stops immediately and this can't be undone.",
    revokeSuccessText: "Sub-key revoked — it will be refused on its next request.",

    tryPlaygroundBtn: "Try it in Playground",
    doneBtn: "Done",
  },
  {
    pageTitle: "我的子 Key",
    pageIntro: "给你的每个 Agent 切一把子 Key。子 Key 的额度永远不会超过你自己的 Key，随时可以撤销任意一把。",

    headerRemainingToday: "我今日剩余",
    headerRemainingTotal: "我总剩余",
    headerCanDelegateYes: "你可以创建子 Key。",
    headerCanDelegateNo: "你不能创建子 Key —— 请联系管理员为你的 Key 开启「可再分配」。",
    headerMaxDepthReached: "你不能创建子 Key —— 已经达到最大分配层级（{depth}）。",

    createBtn: "创建子 Key",
    drawerTitleCreate: "创建子 Key",
    drawerTitleCreated: "子 Key 已创建",

    nameLabel: "这把子 Key 是给谁 / 哪个 Agent 用的",
    namePlaceholder: "例如：我本机的 Claude Code",
    lblDaily: "每日预算",
    lblPerReq: "单次上限",
    lblTotal: "总额度",
    lblThreshold: "审批阈值（可选）",
    thresholdHint: "留空 = 继承我的。",
    thresholdHintWithValue: "留空 = 继承我的：单笔达到 {value} 就需要管理员批准；不能设得比这更高。",
    maxHintDaily: "最多 {limit}（我的每日预算）。我今日还剩 {remaining} —— 子 Key 花的钱从这里扣。",
    maxHintPerReq: "最多 {limit}（我的单次上限）。",
    maxHintTotal: "最多 {limit}（我的总额度）。我总共还剩 {remaining}。",
    shareNote: "额度怎么算：每把子 Key 花的钱同时计入我的 Key（以及我上级的 Key）。子 Key 的额度加起来可以超过我的，但它们合计花费永远不会超过我的剩余额度。我的 Key（或上级 Key）被撤销时，所有子 Key 一并失效。",
    remainingBoundByParent: "受上级 Key 额度限制",
    canDelegateLabel: "允许这把子 Key 再往下切子 Key",
    canDelegateUnavailable: "不可用：再往下切一级会超过最大分配层级。",

    errRequired: "必填。",
    errDecimal: "请输入大于 0、最多 6 位小数的数字。",
    errExceedsMineDaily: "不能超过我自己的每日预算（{value}）。",
    errExceedsMinePerReq: "不能超过我自己的单次上限（{value}）。",
    errExceedsMineTotal: "不能超过我自己的总额度（{value}）。",
    submitBtn: "创建子 Key",
    submitting: "创建中…",

    errFieldExceedsParent: "{field} 不能超过上级：{value}",
    errFieldInvalid: "{field} 不合法：{message}",
    errThresholdOverPerReq: "不能高于这把子 Key 的单次上限。",
    errDelegationNotAllowed: "你没有创建子 Key 的权限。",
    errMaxDepthExceeded: "已达到最大分配层级 —— 这把子 Key 无法再往下切子 Key。",
    errChildrenLimitReached: "你的子 Key 数量已达上限。",

    field_name: "名称",
    field_daily_budget: "每日预算",
    field_total_budget: "总额度",
    field_per_request_limit: "单次上限",
    field_approval_threshold: "审批阈值",
    field_allowed_hosts: "允许访问的地址",
    field_expires_at: "过期时间",
    field_can_delegate: "允许再分配",
    field_max_payments_per_minute: "每分钟最多付款次数",

    createdBanner: "这是唯一一次显示完整 Key，请现在就复制。",
    keyFieldLabel: "子 Key",

    listTitle: "我的子 Key",
    colName: "名称",
    colKeyPrefix: "Key",
    colToday: "今日",
    colPerRequest: "单次",
    colTotal: "累计已用 / 总额度",
    colStatus: "状态",
    colActions: "",

    emptyTitle: "还没有子 Key",
    emptyBody: "给你的每个 Agent 切一把子 Key —— 每把都有自己的额度，从你自己的额度里切出来。",

    revokeBtn: "撤销",
    revokeConfirmText: "确认撤销这把子 Key？正在使用它的 Agent 会立即停止，且不可恢复。",
    revokeSuccessText: "子 Key 已撤销 —— 下一次请求就会被拒绝。",

    tryPlaygroundBtn: "在 Playground 里试试",
    doneBtn: "完成",
  }
);
