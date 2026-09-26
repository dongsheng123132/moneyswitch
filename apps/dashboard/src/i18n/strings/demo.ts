import { defineMessages } from "../index";

/** Offline demo (`npx moneyswitch-server demo`): banner + overview guide card. */
export const demoStrings = defineMessages(
  {
    bannerTag: "DEMO",
    networkBadge: "Demo · mock settlement",
    bannerText: "Simulated settlement — no real money moves. Wallet, payments and earnings here are mock data on a throwaway local server.",
    bannerExit: "Press Ctrl+C in the terminal to stop and delete everything.",
    guideTitle: "Welcome to the MoneySwitch demo",
    guideSub:
      "Everything is pre-set: a mock wallet, a demo LLM channel, two MoneyKeys (“Claude Code”, “Codex”), and a toll booth in front of a demo API. Try these three things:",
    guideChatTitle: "Send a message in the Playground",
    guideChatBody: "The “Claude Code” key is already filled in. One reply costs $0.01, paid over x402.",
    guideChatCta: "Open Playground",
    guideBlockTitle: "Buy a $5 report — watch it get blocked",
    guideBlockBody: "The key's per-request limit is $1, so MoneySwitch refuses before signing anything.",
    guideBlockCta: "Try the $5 report",
    guideEarnTitle: "See toll booth income",
    guideEarnBody: "“Demo Weather API” charges $0.02 per call. Your AI already bought a few — here's what you earned.",
    guideEarnCta: "View earnings",
    guideFooter: "DEMO · simulated settlement through a local mock facilitator — nothing touches a real chain.",
  },
  {
    bannerTag: "DEMO",
    networkBadge: "演示 · 模拟结算",
    bannerText: "模拟结算，不会动真钱。这里的钱包、付款和收入都是临时本地服务器上的模拟数据。",
    bannerExit: "在终端按 Ctrl+C 即可停止并删除全部数据。",
    guideTitle: "欢迎试玩 MoneySwitch",
    guideSub: "已经为你准备好：模拟钱包、一个演示 LLM 渠道、两把 MoneyKey（「Claude Code」「Codex」），以及挡在演示 API 前面的一个收费站。试试这三件事：",
    guideChatTitle: "在 Playground 发一条消息",
    guideChatBody: "已自动填好「Claude Code」这把 Key。一次回复 $0.01，走 x402 付款。",
    guideChatCta: "打开 Playground",
    guideBlockTitle: "买一次 $5 的报告，看它被拦",
    guideBlockBody: "这把 Key 单笔上限 $1，MoneySwitch 在签名前就会拒绝。",
    guideBlockCta: "试试 $5 报告",
    guideEarnTitle: "看收费站收入",
    guideEarnBody: "「Demo Weather API」每次调用收 $0.02。你的 AI 已经买过几次——看看赚了多少。",
    guideEarnCta: "查看收入",
    guideFooter: "DEMO · 通过本地模拟 facilitator 结算，不上任何真实链。",
  }
);
