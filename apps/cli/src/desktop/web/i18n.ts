import { createContext, useCallback, useContext } from "react";

/**
 * Same conventions as apps/dashboard/src/i18n (docs/ux-audit.md A-13): zh/en,
 * default follows the browser, explicit choice remembered in localStorage,
 * zh typed against en keys so a missing translation is a compile error.
 */
export type Lang = "zh" | "en";
const STORAGE_KEY = "moneyswitch_lang";

const en = {
  appTitle: "MoneySwitch Desktop",
  appSubtitle: "Give each AI agent a brain (model key) and a wallet (MoneyKey).",
  localBadge: "Local only · 127.0.0.1",
  sessionOk: "Session verified",

  loginTitle: "Opening the console…",
  loginFailedTitle: "This link has expired",
  loginFailedBody: "For your safety each login link works once. Run `moneyswitch ui` in a terminal again and open the new link.",
  loginNoToken: "Open the link printed in the terminal by `moneyswitch ui` (it ends with #…).",

  accountTitle: "MoneySwitch account",
  accountHelp: "Paste the MoneyKey your admin gave you. It is stored only on this computer (~/.moneyswitch/desktop.json, readable by you only).",
  serverLabel: "Server",
  keyLabel: "My MoneyKey",
  connect: "Connect",
  connecting: "Checking…",
  change: "Change",
  signOutKey: "Forget key",
  refresh: "Refresh",
  remainingToday: "Left today",
  remainingTotal: "Left in total",
  perRequest: "Per request",
  ofDaily: "of {amount} / day",
  canDelegateYes: "Can create child keys",
  canDelegateNo: "Cannot create child keys",
  canDelegateNoHelp: "Ask your admin to turn on “allow re-delegation” for this key, or paste an existing mk_live_ key into each agent.",
  accountUnreachable: "Can't reach the server: {message}",

  bulkTitle: "Set up everything at once",
  bulkBody: "Split today's remaining {amount} evenly into one child key per detected agent ({agents}) and turn them on. You'll see the full diff first.",
  bulkButton: "Preview & enable all",
  bulkNone: "No Claude Code or Codex detected on this computer.",
  bulkEach: "Each agent: {daily}/day · {per}/request · {total} total",

  agentsTitle: "Agents on this computer",
  redetect: "Re-detect",
  detected: "Detected",
  notDetected: "Not detected",
  statusEnabled: "Enabled",
  statusDisabled: "Off",
  statusDrifted: "Changed outside MoneySwitch",
  statusDriftedHelp: "The config file no longer has the values MoneySwitch wrote. Turn it on again to re-apply, or off to restore the original.",
  spentToday: "Spent today",
  manualBadge: "Manual setup",

  brainTitle: "Brain · model",
  brainHelp: "Which model this agent thinks with, and whose API key pays for it.",
  provider: "Provider",
  presetCustom: "Custom",
  baseUrl: "Base URL",
  apiKey: "API key",
  apiKeySaved: "Saved {masked} — leave empty to keep",
  model: "Model",
  modelOptional: "optional — agent default",
  testConnection: "Test connection",
  testing: "Testing…",
  testOk: "Connected in {ms} ms",
  testFail: "Failed: {message}",
  testFailContinue: "You can still save and enable; the agent will show the same error when it runs.",
  save: "Save",
  saved: "Saved",
  keepModel: "Don't change the model",
  brainNotSet: "Not set — the agent keeps its current model settings.",
  brainClear: "Remove",
  brainComingSoon: "Model setup for this agent is coming soon.",
  presetCustomClaude: "Any Anthropic-compatible endpoint. The key is sent as Bearer (ANTHROPIC_AUTH_TOKEN).",
  presetCustomCodex: "Must speak the OpenAI Responses API — Codex 0.156 no longer accepts Chat Completions.",
  presetDeepseekCodex: "Codex only speaks the Responses API. DeepSeek's endpoint is Chat Completions, so this may not work — test the connection first.",

  walletTitle: "Wallet · MoneyKey",
  walletHelp: "What the agent may spend through MoneySwitch (paid APIs via the MCP tools).",
  walletNewChild: "Cut a child key",
  walletPaste: "Paste a key",
  daily: "Per day",
  perReq: "Per request",
  total: "Total",
  childHint: "Can't exceed your limits: {daily}/day, {per}/request.",
  createChild: "Create child key",
  creating: "Creating…",
  pasteKeyLabel: "mk_live_ key",
  useKey: "Use this key",
  walletChild: "Child key",
  walletPasted: "Pasted key",
  walletLimits: "{daily}/day · {per}/request",
  walletRemove: "Remove",
  walletRevoke: "Revoke & remove",
  walletRevokeConfirm: "Revoke this child key on the server? The agent will immediately lose access to it.",
  walletNeedsAccount: "Connect your MoneySwitch account first.",
  walletCannotDelegate: "Your key can't create child keys — paste an existing key instead.",
  walletTurnOffFirst: "Turn the agent off before removing its key.",

  enableLabel: "Enable",
  enabledAt: "Written {when}",
  backups: "Backups",
  enableNeedsSomething: "Set a model or a wallet first.",
  notInstalledEnable: "Not detected on this computer — install it first.",

  diffEnableTitle: "Review changes · enable {agent}",
  diffDisableTitle: "Review changes · turn off {agent}",
  diffBulkTitle: "Review changes · enable all",
  diffIntro: "Only the fields below are changed. Every file is backed up first (<file>.bak-<timestamp>) and read back after writing; if anything fails, all files are restored.",
  diffDisableIntro: "Restores the values that were there before MoneySwitch, and removes what it added.",
  diffField: "Field",
  diffBefore: "Now",
  diffAfter: "After",
  diffNewFile: "new file",
  diffAgentCli: "written by the agent's own CLI",
  diffCommands: "Commands that will run",
  diffNoChanges: "Nothing to change — the files already match.",
  diffAbsent: "(not set)",
  diffNewChild: "(new child key, created on confirm)",
  diffBulkChild: "New child key: {daily}/day · {per}/request · {total} total",
  cancel: "Cancel",
  confirmWrite: "Back up & write",
  confirmDisable: "Restore & turn off",
  writing: "Writing…",
  writtenOk: "{agent}: written. Restart the agent to pick it up.",
  disabledOk: "{agent}: turned off, original settings restored.",

  warn_claudeReplacesExistingMcp: "A “moneyswitch” MCP server already exists (e.g. from `moneyswitch connect`). It will be replaced, and put back when you turn this off.",
  warn_codexReplacesProvider: "Codex currently uses another model_provider. It will switch to MoneySwitch's provider; turning off restores the old one.",
  warn_codexNeedsResponsesApi: "Codex only speaks the OpenAI Responses API; check that this provider supports it (test the connection).",

  manualIntro: "MoneySwitch can't safely write this app's settings yet, so do it in the app:",
  manualNeedsWallet: "Cut a child key (or paste one) above first — the exact steps will appear here.",
  reapply: "Re-apply…",
  stepOpenclawSave: "1. Save this as moneyswitch.json5",
  stepOpenclawDryRun: "2. Check it (changes nothing)",
  stepOpenclawApply: "3. Apply it with OpenClaw's own CLI (it validates and keeps a backup)",
  stepWorkbuddyMcp: "In WorkBuddy → Settings → MCP → Add, paste:",
  stepWorkbuddyModel: "Model: WorkBuddy → Settings → Models → Add custom model (OpenAI compatible):",
  stepCherryMcp: "In Cherry Studio → Settings → MCP Servers → Add → Import from JSON, paste:",
  stepCherryModel: "Model: Cherry Studio → Settings → Model Provider → Add (OpenAI compatible):",
  rowBaseUrl: "Base URL",
  rowApiKey: "API key",
  copy: "Copy",
  copied: "Copied",

  errorGeneric: "Something went wrong: {message}",
  close: "Close",
};

type Keys = keyof typeof en;

const zh: Record<Keys, string> = {
  appTitle: "MoneySwitch 桌面控制台",
  appSubtitle: "给每个 AI Agent 配好「大脑」（模型 Key）和「钱包」（MoneyKey）。",
  localBadge: "仅本机 · 127.0.0.1",
  sessionOk: "会话已验证",

  loginTitle: "正在打开控制台…",
  loginFailedTitle: "这个链接已失效",
  loginFailedBody: "为了安全，每个登录链接只能用一次。请在终端重新运行 `moneyswitch ui`，打开新链接。",
  loginNoToken: "请打开终端里 `moneyswitch ui` 打印的链接（以 #… 结尾）。",

  accountTitle: "MoneySwitch 账户",
  accountHelp: "粘贴管理员发给你的 MoneyKey。只保存在本机（~/.moneyswitch/desktop.json，仅你本人可读）。",
  serverLabel: "服务器",
  keyLabel: "我的 MoneyKey",
  connect: "连接",
  connecting: "校验中…",
  change: "更换",
  signOutKey: "忘记这把 Key",
  refresh: "刷新",
  remainingToday: "今日剩余",
  remainingTotal: "总剩余",
  perRequest: "单次上限",
  ofDaily: "每日额度 {amount}",
  canDelegateYes: "可以切子 Key",
  canDelegateNo: "不能切子 Key",
  canDelegateNoHelp: "请让管理员为这把 Key 打开「允许员工再分配」，或者给每个 Agent 粘贴现成的 mk_live_ Key。",
  accountUnreachable: "连不上服务器：{message}",

  bulkTitle: "一键全配",
  bulkBody: "把今日剩余的 {amount} 平均切成子 Key，分给本机检测到的每个 Agent（{agents}）并启用。确认前会先展示完整 diff。",
  bulkButton: "预览并全部启用",
  bulkNone: "本机没有检测到 Claude Code 或 Codex。",
  bulkEach: "每个 Agent：每天 {daily} · 单次 {per} · 总额 {total}",

  agentsTitle: "本机 Agent",
  redetect: "重新检测",
  detected: "已安装",
  notDetected: "未检测到",
  statusEnabled: "已启用",
  statusDisabled: "未启用",
  statusDrifted: "配置被外部修改",
  statusDriftedHelp: "配置文件里已不是 MoneySwitch 写入的值。重新启用会再写一次；关闭会恢复原始配置。",
  spentToday: "今日花费",
  manualBadge: "手动配置",

  brainTitle: "大脑 · 模型",
  brainHelp: "这个 Agent 用哪个模型思考，用谁的 API Key 付模型费。",
  provider: "提供商",
  presetCustom: "自定义",
  baseUrl: "Base URL",
  apiKey: "API Key",
  apiKeySaved: "已保存 {masked}，留空表示不改",
  model: "模型",
  modelOptional: "可不填，用 Agent 默认",
  testConnection: "测试连接",
  testing: "测试中…",
  testOk: "连接成功，{ms} ms",
  testFail: "失败：{message}",
  testFailContinue: "仍可保存并启用；Agent 运行时会看到同样的错误。",
  save: "保存",
  saved: "已保存",
  keepModel: "不修改模型",
  brainNotSet: "未设置——Agent 保持现有的模型配置。",
  brainClear: "移除",
  brainComingSoon: "这个 Agent 的模型配置即将支持。",
  presetCustomClaude: "任意兼容 Anthropic 的地址。Key 以 Bearer 方式发送（ANTHROPIC_AUTH_TOKEN）。",
  presetCustomCodex: "必须兼容 OpenAI Responses API——Codex 0.156 已不再接受 Chat Completions。",
  presetDeepseekCodex: "Codex 只支持 Responses API，而 DeepSeek 的接口是 Chat Completions，可能无法使用——请先测试连接。",

  walletTitle: "钱包 · MoneyKey",
  walletHelp: "这个 Agent 通过 MoneySwitch 能花多少钱（MCP 工具调用付费 API）。",
  walletNewChild: "切一把子 Key",
  walletPaste: "粘贴现成 Key",
  daily: "每天",
  perReq: "单次",
  total: "总额",
  childHint: "不能超过你的额度：每天 {daily}，单次 {per}。",
  createChild: "生成子 Key",
  creating: "生成中…",
  pasteKeyLabel: "mk_live_ Key",
  useKey: "使用这把 Key",
  walletChild: "子 Key",
  walletPasted: "粘贴的 Key",
  walletLimits: "每天 {daily} · 单次 {per}",
  walletRemove: "移除",
  walletRevoke: "撤销并移除",
  walletRevokeConfirm: "在服务器上撤销这把子 Key？Agent 会立即无法再用它付款。",
  walletNeedsAccount: "请先连接 MoneySwitch 账户。",
  walletCannotDelegate: "你的 Key 不能切子 Key——请改为粘贴现成的 Key。",
  walletTurnOffFirst: "请先关闭这个 Agent，再移除它的 Key。",

  enableLabel: "启用",
  enabledAt: "已于 {when} 写入",
  backups: "备份",
  enableNeedsSomething: "请先设置大脑或钱包。",
  notInstalledEnable: "本机未检测到它——请先安装。",

  diffEnableTitle: "确认改动 · 启用 {agent}",
  diffDisableTitle: "确认改动 · 关闭 {agent}",
  diffBulkTitle: "确认改动 · 全部启用",
  diffIntro: "只改动下面列出的字段。每个文件写入前先备份（<文件>.bak-<时间戳>），写后重新读回校验；任何一步失败都会自动恢复全部文件。",
  diffDisableIntro: "恢复 MoneySwitch 写入前的原值，并移除它添加的内容。",
  diffField: "字段",
  diffBefore: "现在",
  diffAfter: "写入后",
  diffNewFile: "新文件",
  diffAgentCli: "由 Agent 自己的命令行写入",
  diffCommands: "将执行的命令",
  diffNoChanges: "无需改动——文件已经是这个配置。",
  diffAbsent: "（未设置）",
  diffNewChild: "（新子 Key，确认后生成）",
  diffBulkChild: "新子 Key：每天 {daily} · 单次 {per} · 总额 {total}",
  cancel: "取消",
  confirmWrite: "备份并写入",
  confirmDisable: "恢复并关闭",
  writing: "写入中…",
  writtenOk: "{agent}：已写入。重启该 Agent 后生效。",
  disabledOk: "{agent}：已关闭，原配置已恢复。",

  warn_claudeReplacesExistingMcp: "已存在名为 moneyswitch 的 MCP 服务器（例如之前 `moneyswitch connect` 写入的）。它会被替换，关闭时再放回去。",
  warn_codexReplacesProvider: "Codex 当前使用另一个 model_provider，将切换为 MoneySwitch 的提供商；关闭时恢复原来的。",
  warn_codexNeedsResponsesApi: "Codex 只支持 OpenAI Responses API，请确认该提供商支持（先测试连接）。",

  manualIntro: "MoneySwitch 暂时无法安全地自动写入这个应用的配置，请在应用里操作：",
  manualNeedsWallet: "先在上方切一把子 Key（或粘贴现成的），这里会给出对应的配置步骤。",
  reapply: "重新写入…",
  stepOpenclawSave: "1. 把下面内容保存为 moneyswitch.json5",
  stepOpenclawDryRun: "2. 先检查（不做任何修改）",
  stepOpenclawApply: "3. 用 OpenClaw 自己的命令写入（会校验并保留备份）",
  stepWorkbuddyMcp: "WorkBuddy → 设置 → MCP → 添加，粘贴：",
  stepWorkbuddyModel: "模型：WorkBuddy → 设置 → 模型 → 添加自定义模型（OpenAI 兼容）：",
  stepCherryMcp: "Cherry Studio → 设置 → MCP 服务器 → 添加 → 从 JSON 导入，粘贴：",
  stepCherryModel: "模型：Cherry Studio → 设置 → 模型服务 → 添加（OpenAI 兼容）：",
  rowBaseUrl: "Base URL",
  rowApiKey: "API Key",
  copy: "复制",
  copied: "已复制",

  errorGeneric: "出错了：{message}",
  close: "关闭",
};

export type MsgKey = Keys;
export const messages = { en, zh };

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // ignore
  }
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const lower = (l || "").toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

export function saveLang(l: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // ignore
  }
}

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "en", setLang: () => undefined });

export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

export function useT(): T {
  const { lang } = useContext(LangContext);
  return useCallback(
    (key: MsgKey, vars?: Record<string, string | number>) => {
      const tpl = messages[lang][key] ?? messages.en[key] ?? key;
      return vars ? tpl.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : tpl;
    },
    [lang]
  );
}

export function hasKey(k: string): k is MsgKey {
  return k in en;
}
