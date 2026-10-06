import { defineMessages } from "../index";

/** Copy for the Bills page (the payment ledger; SPEC.md §2). */
export const billsStrings = defineMessages(
  {
    allKeys: "All keys",
    searchPlaceholder: "Search tx hash, URL…",
    clearFilters: "Clear filters",
    exportCsv: "Export CSV",
    rangeToday: "Today",
    range24h: "Last 24h",
    range7d: "Last 7d",
    rangeAll: "All time",

    summaryCount: "Payments",
    summaryTotal: "Total amount",
    summaryTotalMainnet: "Total · mainnet (real USDC)",
    summaryTotalTestnet: "Total · testnet (test USDC, no value)",
    summaryTotalOther: "Total · other chains",
    kindFilterLabel: "Network type",
    kindAny: "All",
    summaryMaybe: "Charge not known yet",

    colTime: "Time",
    colKey: "Key",
    colAmount: "Amount",
    colUrl: "URL",
    colChain: "Chain",
    colTx: "Tx",
    colCharged: "Charged",

    chargedAny: "Any",
    chargedYes: "Yes",
    chargedNo: "No",
    chargedMaybe: "Maybe",
    chargedYesHint: "The payment is confirmed: the money left the wallet.",
    chargedNoHint: "Nothing was charged.",
    chargedMaybeHint:
      "The payment was signed but its result is not known yet. MoneySwitch checks the chain by itself and fills in the transaction. Do not pay again by hand.",

    emptyNoPaymentsTitle: "No payments yet",
    emptyNoPaymentsBody: "Once an AI pays through MoneySwitch, every payment shows up here.",
    emptyNoPaymentsAction: "Go to Keys",
    emptyFilteredTitle: "No payments match",
    emptyFilteredBody: "Try a different filter or search term.",

    truncatedNotice: "Showing only the latest {shown} payments ({total} in total). The totals and the CSV export cover only these.",
    renderCapNotice: "Showing the newest {shown} of {matching} matching payments. The count, the total and the CSV export cover all {matching}.",
  },
  {
    allKeys: "全部 Key",
    searchPlaceholder: "搜索交易哈希 / URL…",
    clearFilters: "清除筛选",
    exportCsv: "导出 CSV",
    rangeToday: "今天",
    range24h: "近 24 小时",
    range7d: "近 7 天",
    rangeAll: "全部时间",

    summaryCount: "笔数",
    summaryTotal: "总金额",
    summaryTotalMainnet: "合计 · 主网（真 USDC）",
    summaryTotalTestnet: "合计 · 测试网（测试 USDC，没有价值）",
    summaryTotalOther: "合计 · 其他链",
    kindFilterLabel: "网络类型",
    kindAny: "全部",
    summaryMaybe: "尚不确定是否扣款",

    colTime: "时间",
    colKey: "Key",
    colAmount: "金额",
    colUrl: "网址",
    colChain: "链",
    colTx: "交易",
    colCharged: "是否扣款",

    chargedAny: "全部",
    chargedYes: "是",
    chargedNo: "否",
    chargedMaybe: "不确定",
    chargedYesHint: "已确认付款：钱已经从钱包转出。",
    chargedNoHint: "没有扣款。",
    chargedMaybeHint: "付款已签名，但结果还不明确。MoneySwitch 会自己去链上核对并补上交易号。请不要手动重复付款。",

    emptyNoPaymentsTitle: "还没有付款记录",
    emptyNoPaymentsBody: "AI 通过 MoneySwitch 付款后，每一笔都会出现在这里。",
    emptyNoPaymentsAction: "去发一把 Key",
    emptyFilteredTitle: "没有符合条件的记录",
    emptyFilteredBody: "换一个筛选条件或搜索词试试。",

    truncatedNotice: "只显示最近 {shown} 笔付款（共 {total} 笔）；合计和导出只覆盖这些。",
    renderCapNotice: "只列出最新的 {shown} 笔（符合条件的共 {matching} 笔）；笔数、合计和导出覆盖全部 {matching} 笔。",
  }
);
