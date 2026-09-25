import { defineMessages } from "../index";

/** Connect Agent page copy (docs/ux-audit.md A-12, C-1, C-2, C-3). */
export const connectStrings = defineMessages(
  {
    keyCardTitle: "Your MoneyKey",
    keyInputLabel: "Paste a mk_live_ key to fill it into every snippet below (used on this page only, not stored)",
    keyNote: "Keys are shown once at creation.",
    keyCreateLink: "Create a new key",

    cliTarballNote: "These commands download the MoneySwitch CLI (~150 KB, Apache-2.0) from this server. Needs Node.js 20+.",
    cliLocalNote: "These commands use the CLI built in this repo — they only work on this computer.",
    cliNpmWarnTitle: "The moneyswitch npm package isn't published yet",
    cliNpmWarnBody: "Run pnpm build so this server can serve the CLI, or use the manual snippets below.",

    tabMcp: "Desktop agents (MCP)",
    tabOpenai: "OpenAI SDK",
    tabRest: "REST",

    oneLineTitle: "One-line connect (Claude Code / Codex)",
    oneLineBody: "Preview first, then apply. Both commands write nothing until --apply runs.",
    previewLabel: "Preview (dry run)",
    applyLabel: "Apply",
    statusLabel: "Check the budget",

    claudeManualTitle: "Claude Code (manual)",
    claudeManualNote: "-s user registers it for every project. On Windows, wrap the command with cmd /c if you run it outside a POSIX shell.",
    codexManualTitle: "Codex (manual)",
    codexManualNote: "Append this to ~/.codex/config.toml.",
    mcpAnyTitle: "Any MCP client (Cursor, Claude Desktop, …)",
    mcpAnyNote: "Paste as an MCP server entry. Exposes 3 tools: money_status, paid_fetch, money_history.",

    openaiTitle: "OpenAI-compatible",
    openaiBaseUrlLabel: "Base URL",
    openaiKeyLabel: "API key",
    openaiOtherClientsTitle: "Cherry Studio / Open WebUI / NewAPI",

    restTitle: "REST",
    restFetchTitle: "Paid fetch",
    restStatusTitle: "Check budget",
    restFieldsTitle: "/v1/fetch response fields",
    restFieldStatus: "status",
    restFieldStatusDesc: "ok | denied | approval_required | payment_failed | error",
    restFieldCode: "code",
    restFieldCodeDesc: "machine-readable error code",
    restFieldPayment: "payment",
    restFieldPaymentDesc: "{amount, tx_hash, network, mock}",
    restFieldApprovalId: "approval_id",
    restFieldApprovalIdDesc: "re-send the request with it after an admin approves",
    restFieldRemainingToday: "remaining_today",
    restFieldRemainingTotal: "remaining_total",
    restAllowedHostsNote: "The target host must be in the key's allowed hosts.",
  },
  {
    keyCardTitle: "你的 MoneyKey",
    keyInputLabel: "粘贴一个 mk_live_ 开头的 Key，会自动填入下面所有代码片段（只在本页使用，不会被保存）",
    keyNote: "Key 只在创建时完整显示一次。",
    keyCreateLink: "去创建一个新 Key",

    cliTarballNote: "下面的命令会从这台服务器下载 MoneySwitch CLI（约 150 KB，Apache-2.0），需要 Node.js 20+。",
    cliLocalNote: "下面的命令使用本仓库构建出的 CLI，只能在这台电脑上运行。",
    cliNpmWarnTitle: "moneyswitch 这个 npm 包还没发布",
    cliNpmWarnBody: "运行 pnpm build 让这台服务器可以提供 CLI，或者使用下面的手动配置片段。",

    tabMcp: "桌面 Agent（MCP）",
    tabOpenai: "OpenAI SDK",
    tabRest: "REST",

    oneLineTitle: "一键接入（Claude Code / Codex）",
    oneLineBody: "先预览，再应用；两条命令在执行 --apply 之前都不会写入任何东西。",
    previewLabel: "预览（不改动）",
    applyLabel: "应用",
    statusLabel: "查看额度",

    claudeManualTitle: "Claude Code（手动）",
    claudeManualNote: "-s user 会在所有项目里生效。Windows 上如果不是在 POSIX shell 里运行，用 cmd /c 包一层。",
    codexManualTitle: "Codex（手动）",
    codexManualNote: "追加到 ~/.codex/config.toml 里。",
    mcpAnyTitle: "任意 MCP 客户端（Cursor、Claude Desktop……）",
    mcpAnyNote: "作为一条 MCP server 配置粘贴进去，暴露 3 个工具：money_status、paid_fetch、money_history。",

    openaiTitle: "OpenAI 兼容接口",
    openaiBaseUrlLabel: "Base URL",
    openaiKeyLabel: "API Key",
    openaiOtherClientsTitle: "Cherry Studio / Open WebUI / NewAPI",

    restTitle: "REST",
    restFetchTitle: "付费抓取",
    restStatusTitle: "查看额度",
    restFieldsTitle: "/v1/fetch 返回字段",
    restFieldStatus: "status",
    restFieldStatusDesc: "ok | denied | approval_required | payment_failed | error",
    restFieldCode: "code",
    restFieldCodeDesc: "机器可读的错误码",
    restFieldPayment: "payment",
    restFieldPaymentDesc: "{amount, tx_hash, network, mock}",
    restFieldApprovalId: "approval_id",
    restFieldApprovalIdDesc: "管理员通过审批后，带上它重新发送请求",
    restFieldRemainingToday: "remaining_today",
    restFieldRemainingTotal: "remaining_total",
    restAllowedHostsNote: "目标主机必须在这把 Key 的允许访问主机列表里。",
  }
);
