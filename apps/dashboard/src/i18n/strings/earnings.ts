import { defineMessages } from "../index";

/** Earnings page copy (SPEC-v0.5 §3). */
export const earningsStrings = defineMessages(
  {
    rangeToday: "Today",
    range7d: "Last 7 days",
    rangeAll: "All time",
    allTollbooths: "All toll booths",
    exportCsv: "Export CSV",

    kpiTotal: "Total settled",
    kpiSettledCount: "Successful payments",
    kpiFailedCount: "Not charged",
    kpiFailedHint: "Requests where the upstream failed — the buyer was not charged for these.",

    byTollboothTitle: "By toll booth",
    byRouteTitle: "By rule",
    itemsTitle: "Every payment",
    itemsHint: "\"Paid\" = the USDC reached your receiving address. \"Not charged\" = your service answered with an error, so the buyer paid nothing.",
    colName: "Toll booth",
    colRoute: "Rule",
    colCount: "Count",
    colTotal: "Total",
    defaultRoute: "Everything else (default price)",

    colTime: "Time",
    colTollbooth: "Toll booth",
    colRouteShort: "Route",
    colAmount: "Amount",
    colPayer: "Payer",
    colTx: "Tx",
    colUpstream: "Upstream",
    colStatus: "Status",
    statusSettled: "Paid",
    statusFailed: "Not charged (upstream 5xx)",

    emptyTitle: "No income yet",
    emptyBody: "Income shows up here as soon as someone pays through one of your toll booths.",
    emptyAction: "Set up a toll booth",
  },
  {
    rangeToday: "今天",
    range7d: "近 7 天",
    rangeAll: "全部",
    allTollbooths: "全部收费站",
    exportCsv: "导出 CSV",

    kpiTotal: "收入合计",
    kpiSettledCount: "成功笔数",
    kpiFailedCount: "未扣款笔数",
    kpiFailedHint: "上游出错时不向买家收费，这些请求不计入收入。",

    byTollboothTitle: "按收费站",
    byRouteTitle: "按规则",
    itemsTitle: "每一笔",
    itemsHint: "「已到账」= USDC 已进入你的收款地址；「未扣款」= 你的服务返回了错误，买家一分钱没付。",
    colName: "收费站",
    colRoute: "规则",
    colCount: "笔数",
    colTotal: "金额",
    defaultRoute: "其余路径（默认价）",

    colTime: "时间",
    colTollbooth: "收费站",
    colRouteShort: "路由",
    colAmount: "金额",
    colPayer: "付款人",
    colTx: "交易",
    colUpstream: "上游状态",
    colStatus: "状态",
    statusSettled: "已到账",
    statusFailed: "未扣款（上游 5xx）",

    emptyTitle: "还没有收入",
    emptyBody: "有人通过你的收费站付款后，收入会出现在这里。",
    emptyAction: "新建收费站",
  }
);
