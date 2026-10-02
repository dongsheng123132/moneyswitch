// Every copy-paste snippet the Dashboard shows, generated in ONE place from
// the real origin + the real way to get the client CLI (docs/ux-audit.md
// A-10/A-11/A-12/C-1/C-2). Never hard-code a host, port or local path here.
import { useEffect, useState } from "react";
import { renderInstallPrompt } from "@moneyswitch/skill";
import { isCliTarballAvailable, type AdminMeta } from "./api";

/** How this machine / an employee's machine can run the `moneyswitch` client CLI. */
export type CliSource =
  | { kind: "tarball"; url: string } // served by this server at /dl/moneyswitch.tgz (works anywhere with Node)
  | { kind: "local"; cliPath: string; mcpPath: string | null } // absolute path on the server machine (admin only)
  | { kind: "npm" }; // fallback: the published `moneyswitch` npm package

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
  return `${lang === "zh" ? "查看额度和流水" : "View budget and history"}: ${p.origin}/login

` +
    renderInstallPrompt({ baseUrl: p.origin, key: p.key, keyName: p.name, agent: "other" });
}

export function maskKey(key: string): string {
  if (!key.startsWith("mk_live_") || key.length <= 16) return key;
  return `${key.slice(0, 12)}${"•".repeat(8)}${key.slice(-4)}`;
}

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

// ---------------------------------------------------------------------------
