import { defineMessages } from "../index";

/** "Give this to your AI" (skill) block + "Reset secret and copy skill" (key rotation). */
export const skillStrings = defineMessages(
  {
    // tabs / grouping
    tabSkill: "Give this to your AI (skill)",
    tabOther: "Plain HTTP (advanced)",
    recommended: "Recommended",
    otherIntro: "Any program can call POST /v1/fetch directly. Use this when the skill is not an option.",
    rawHttpTitle: "POST /v1/fetch",
    rawHttpNote: "Replace the url with the paid API; max_price is the most this call may cost (USDC). The host must be in the key's allowed hosts.",

    // the block
    blockTitle: "Paste one block into your AI. It saves a skill and learns to pay.",
    blockBody:
      "The block holds this server's address and this key, plus instructions for paying x402 APIs. Your AI keeps it as a skill and uses it whenever it meets a 402 or you ask it to buy something.",
    nudge: "One key per agent. Name each key after the agent (Codex, OpenClaw, ...), so each one has its own budget and can be revoked on its own.",
    pickAgent: "Which AI is this for?",
    agent_codex: "Codex",
    "agent_claude-code": "Claude Code",
    agent_openclaw: "OpenClaw",
    agent_hermes: "Hermes",
    agent_other: "Other",
    copyBtn: "Copy for {agent}",
    copiedBtn: "Copied. Now paste it into {agent}",
    savedAt: "Your AI will save it at: {path}",
    savedAtOther: "Your AI will save it in its skills folder as moneyswitch-pay/SKILL.md.",
    stepsTitle: "How it works",
    step1: "Click the copy button.",
    step2: "Paste it into {agent} as a normal message.",
    step3: "It saves the skill and tells you the budget it can spend.",
    previewTitle: "Preview (the key is hidden here, the copy has it)",
    secretHint: "The copied text contains this key. Paste it only into your own AI, never into a shared chat, and never commit it to git.",
    needKey: "Paste a MoneyKey (mk_live_...) above to build the text for your AI.",
    badKey: "That does not look like a MoneyKey. It starts with mk_live_ and has only letters and digits.",
    badUrl:
      "The address of this page ({url}) cannot be written into a skill. Open the Dashboard from its normal web address (for example http://localhost:4020), or set MONEYSWITCH_PUBLIC_URL on the server.",
    lostKey: "Lost this key? Keys are stored hashed and cannot be shown again. In the key list use \"Reset secret and copy skill\".",

    // rotation
    rotateBtn: "Reset secret and copy skill",
    rotateTitle: "Reset the secret of \"{name}\"?",
    rotateBody:
      "This issues a new secret for the same key. The old secret stops working immediately, so any agent still using it gets errors until you paste the new text into it. Budgets, history, child keys and settings stay as they are.",
    rotateConfirm: "Reset secret",
    rotating: "Resetting...",
    rotateDrawerTitle: "New secret",
    rotatedBanner: "New secret for \"{name}\". The old one no longer works, so paste the text below into the agent again. This is the only time it is shown.",
    rotateFailed: "Could not reset the secret: {message}",
  },
  {
    tabSkill: "交给你的 AI（skill）",
    tabOther: "纯 HTTP（进阶）",
    recommended: "推荐",
    otherIntro: "任何程序都可以直接调用 POST /v1/fetch。skill 用不了时再选它。",
    rawHttpTitle: "POST /v1/fetch",
    rawHttpNote: "把 url 换成要付费调用的 API；max_price 是这一次最多愿意花的 USDC。这个域名必须在这把 key 的允许域名里。",

    blockTitle: "把一整段文字粘贴给你的 AI，它会存成 skill 并学会付费。",
    blockBody: "这段文字里有本服务器的地址、这把 key，以及付费调用 x402 接口的说明。AI 把它存成 skill，之后遇到 402 或你让它买东西时就会用。",
    nudge: "一个 AI 一把 key。给每把 key 起成 AI 的名字（Codex、OpenClaw……），这样各有各的额度，也能单独撤销。",
    pickAgent: "这是给哪个 AI 的？",
    agent_codex: "Codex",
    "agent_claude-code": "Claude Code",
    agent_openclaw: "OpenClaw",
    agent_hermes: "Hermes",
    agent_other: "其他",
    copyBtn: "复制，给 {agent}",
    copiedBtn: "已复制，去粘贴给 {agent}",
    savedAt: "AI 会把它存到：{path}",
    savedAtOther: "AI 会把它存进自己的 skills 目录，文件为 moneyswitch-pay/SKILL.md。",
    stepsTitle: "怎么用",
    step1: "点复制按钮。",
    step2: "像普通消息一样粘贴给 {agent}。",
    step3: "它会存好 skill，并告诉你它能花的额度。",
    previewTitle: "预览（这里隐藏了 key，复制出去的是完整的）",
    secretHint: "复制出去的文字里含有这把 key。只粘贴给你自己的 AI，不要发到共享群聊，不要提交到 git。",
    needKey: "在上面粘贴一把 MoneyKey（mk_live_…），才能生成给 AI 的文字。",
    badKey: "这不像 MoneyKey。MoneyKey 以 mk_live_ 开头，只含字母和数字。",
    badUrl: "本页地址（{url}）不能写进 skill。请从正常的网址打开控制台（例如 http://localhost:4020），或在服务器上设置 MONEYSWITCH_PUBLIC_URL。",
    lostKey: "找不到这把 key 了？key 只存哈希，无法再次显示。请在 key 列表里点“重置密钥并复制 skill”。",

    rotateBtn: "重置密钥并复制 skill",
    rotateTitle: "重置“{name}”的密钥？",
    rotateBody:
      "会为同一把 key 生成新的密钥。旧密钥立刻失效，仍在用旧密钥的 AI 会报错，直到你把新的文字粘贴给它。额度、历史、子 key 和各项设置都保持不变。",
    rotateConfirm: "重置密钥",
    rotating: "重置中…",
    rotateDrawerTitle: "新密钥",
    rotatedBanner: "“{name}”的新密钥已生成。旧的不能再用了，请把下面的文字重新粘贴给对应的 AI。只显示这一次。",
    rotateFailed: "重置密钥失败：{message}",
  }
);
