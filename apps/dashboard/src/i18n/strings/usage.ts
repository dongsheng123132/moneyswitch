import { defineMessages } from "../index";

/** Copy for the Usage page (docs/ux-audit.md D-4). */
export const usageStrings = defineMessages(
  {
    allAgents: "All agents",
    searchPlaceholder: "Search tx hash, URL, model…",
    clearFilters: "Clear filters",
    exportCsv: "Export CSV",
    rangeToday: "Today",
    range24h: "Last 24h",
    range7d: "Last 7d",
    rangeAll: "All time",

    summaryCount: "Payments",
    summaryTotal: "Total amount",
    summaryNeedsReview: "Needs review",

    colTime: "Time",
    colAgent: "Agent",
    colType: "Type",
    colTarget: "Target",
    colAmount: "Amount",
    colTokens: "Tokens",
    colStatus: "Status",
    colTx: "Tx",

    emptyNoPaymentsTitle: "No payments yet",
    emptyNoPaymentsBody: "Once an agent spends through MoneySwitch, its payments show up here.",
    emptyNoPaymentsAction: "Open Playground",
    emptyFilteredTitle: "No payments match",
    emptyFilteredBody: "Try a different filter or search term.",
  },
  {
    allAgents: "全部 Agent",
    searchPlaceholder: "搜索交易哈希 / URL / 模型…",
    clearFilters: "清除筛选",
    exportCsv: "导出 CSV",
    rangeToday: "今天",
    range24h: "近 24 小时",
    range7d: "近 7 天",
    rangeAll: "全部时间",

    summaryCount: "笔数",
    summaryTotal: "总金额",
    summaryNeedsReview: "待核对",

    colTime: "时间",
    colAgent: "Agent",
    colType: "类型",
    colTarget: "目标",
    colAmount: "金额",
    colTokens: "Tokens",
    colStatus: "状态",
    colTx: "交易",

    emptyNoPaymentsTitle: "还没有付款记录",
    emptyNoPaymentsBody: "Agent 通过 MoneySwitch 花钱后，记录会出现在这里。",
    emptyNoPaymentsAction: "打开 Playground",
    emptyFilteredTitle: "没有符合条件的记录",
    emptyFilteredBody: "换一个筛选条件或搜索词试试。",
  }
);
