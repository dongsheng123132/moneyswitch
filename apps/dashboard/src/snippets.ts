// Every copy-paste snippet the Dashboard shows, generated in ONE place from
// the real origin + the real way to get the client CLI (docs/ux-audit.md
// A-10/A-11/A-12/C-1/C-2). Never hard-code a host, port or local path here.
import { useEffect, useState } from "react";
import { isCliTarballAvailable, type AdminMeta } from "./api";

/** How this machine / an employee's machine can run the `moneyswitch` client CLI. */
export type CliSource =
  | { kind: "tarball"; url: string } // served by this server at /dl/moneyswitch.tgz (works anywhere with Node)
  | { kind: "local"; cliPath: string; mcpPath: string | null } // absolute path on the server machine (admin only)
  | { kind: "npm" }; // fallback: requires the package to be published

export const KEY_PLACEHOLDER = "mk_live_xxx";

export function openaiBase(origin: string): string {
  return `${origin}/v1`;
}

function q(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Prefix that runs the `moneyswitch` CLI, e.g. `npx -y --package=<url> moneyswitch`. */
export function cliInvoke(src: CliSource): string {
  if (src.kind === "tarball") return `npx -y --package=${src.url} moneyswitch`;
  if (src.kind === "local") return `node ${q(src.cliPath)}`;
  return "npx -y moneyswitch";
}

export function connectCommand(src: CliSource, origin: string, key: string, apply = true): string {
  return `${cliInvoke(src)} connect --server ${origin} --key ${key}${apply ? " --apply" : ""}`;
}

export function statusCommand(src: CliSource, origin: string, key: string): string {
  return `${cliInvoke(src)} status --server ${origin} --key ${key}`;
}

/** The process an MCP client should spawn for the MoneySwitch stdio MCP server. */
export function mcpLaunch(src: CliSource): { command: string; args: string[] } {
  if (src.kind === "tarball") return { command: "npx", args: ["-y", `--package=${src.url}`, "moneyswitch", "mcp"] };
  if (src.kind === "local") return src.mcpPath ? { command: "node", args: [src.mcpPath] } : { command: "node", args: [src.cliPath, "mcp"] };
  return { command: "npx", args: ["-y", "moneyswitch", "mcp"] };
}

/** `claude mcp add` with user scope (-s user), so it works in every directory, not just the current one. */
export function claudeMcpCommand(src: CliSource, origin: string, key: string): string {
  const { command, args } = mcpLaunch(src);
  return `claude mcp add moneyswitch -s user -e MONEY_API_BASE=${origin} -e MONEY_API_KEY=${key} -- ${[command, ...args].map(q).join(" ")}`;
}

export function codexToml(src: CliSource, origin: string, key: string): string {
  const { command, args } = mcpLaunch(src);
  return [
    "[mcp_servers.moneyswitch]",
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "",
    "[mcp_servers.moneyswitch.env]",
    `MONEY_API_BASE = ${JSON.stringify(origin)}`,
    `MONEY_API_KEY = ${JSON.stringify(key)}`,
  ].join("\n");
}

export function mcpJson(src: CliSource, origin: string, key: string): string {
  const { command, args } = mcpLaunch(src);
  return JSON.stringify({ mcpServers: { moneyswitch: { command, args, env: { MONEY_API_BASE: origin, MONEY_API_KEY: key } } } }, null, 2);
}

export function envSnippet(origin: string, key: string): string {
  return `MONEY_API_BASE=${origin}\nMONEY_API_KEY=${key}`;
}

export function openaiPython(origin: string, key: string, model: string): string {
  return [
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url="${openaiBase(origin)}", api_key="${key}")`,
    "",
    "resp = client.chat.completions.create(",
    `    model="${model}",`,
    '    messages=[{"role": "user", "content": "hello"}],',
    ")",
    "print(resp.choices[0].message.content)",
    'print(resp.model_extra.get("moneyswitch"))  # cost / tx_hash / remaining_today',
  ].join("\n");
}

export function openaiNode(origin: string, key: string, model: string): string {
  return [
    'import OpenAI from "openai";',
    "",
    `const client = new OpenAI({ baseURL: "${openaiBase(origin)}", apiKey: "${key}" });`,
    "",
    "const resp = await client.chat.completions.create({",
    `  model: "${model}",`,
    '  messages: [{ role: "user", content: "hello" }],',
    "});",
    "console.log(resp.choices[0].message.content);",
    "console.log(resp.moneyswitch); // { cost, tx_hash, remaining_today, ... }",
  ].join("\n");
}

export function openaiCurl(origin: string, key: string, model: string): string {
  return [
    `curl ${openaiBase(origin)}/chat/completions \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`,
  ].join("\n");
}

export function restFetchCurl(origin: string, key: string, targetUrl: string): string {
  return [
    `curl ${origin}/v1/fetch \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"url":"${targetUrl}","max_price":"0.05"}'`,
  ].join("\n");
}

export function restStatusCurl(origin: string, key: string): string {
  return `curl ${origin}/v1/status -H "Authorization: Bearer ${key}"`;
}

export function newApiSnippet(origin: string, key: string): string {
  return ["Type:     OpenAI", `Base URL: ${openaiBase(origin)}`, `API Key:  ${key}`].join("\n");
}

/**
 * Chinese / English message an admin pastes into 企业微信 / 飞书 / Slack
 * (SPEC-v0.3-employee.md §A.7). Only commands that actually work.
 */
export function employeeMessage(lang: "zh" | "en", p: { origin: string; name: string; key: string; src: CliSource }): string {
  const cmd = connectCommand(p.src, p.origin, p.key, true);
  if (lang === "zh") {
    return [
      `【MoneySwitch】${p.name} 的 AI 付费额度已开通`,
      "",
      `① 看额度 / 流水 / 直接对话：打开 ${p.origin}/login ，粘贴下面的 Key 登录`,
      `Key：${p.key}`,
      "",
      "② 一键接入本机 Claude Code / Codex（需要 Node.js 20+，在终端运行）：",
      cmd,
      "（去掉末尾的 --apply 只预览、不改任何配置）",
      "",
      "③ 其他支持 OpenAI 协议的客户端（Cherry Studio / Open WebUI 等）：",
      `Base URL：${openaiBase(p.origin)}`,
      "API Key：同上",
      "",
      "这把 Key 有额度上限，只发给你本人，请不要转发。",
    ].join("\n");
  }
  return [
    `[MoneySwitch] Spending key for ${p.name} is ready`,
    "",
    `1) Budget / history / chat: open ${p.origin}/login and paste this key`,
    `Key: ${p.key}`,
    "",
    "2) Connect Claude Code / Codex on your machine (needs Node.js 20+, run in a terminal):",
    cmd,
    "(drop the trailing --apply to preview without changing anything)",
    "",
    "3) Any OpenAI-compatible client (Cherry Studio, Open WebUI, ...):",
    `Base URL: ${openaiBase(p.origin)}`,
    "API Key: same as above",
    "",
    "This key has spending limits and is for you only - please don't forward it.",
  ].join("\n");
}

/** Masks the middle of a secret for on-screen display; copy buttons still copy the full value. */
export function maskKey(key: string): string {
  if (!key.startsWith("mk_live_") || key.length <= 16) return key;
  return `${key.slice(0, 12)}${"•".repeat(8)}${key.slice(-4)}`;
}

/**
 * Resolves the best CliSource: the server-hosted tarball when it exists,
 * else (admin only) the absolute local path, else the npm name.
 */
export function useCliSource(meta?: AdminMeta | null): CliSource {
  const [tarball, setTarball] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    isCliTarballAvailable().then((ok) => {
      if (alive) setTarball(ok);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (tarball) return { kind: "tarball", url: `${window.location.origin}/dl/moneyswitch.tgz` };
  if (meta?.cli_local_path) return { kind: "local", cliPath: meta.cli_local_path, mcpPath: meta.mcp_local_path };
  return { kind: "npm" };
}
