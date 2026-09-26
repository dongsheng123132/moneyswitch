import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { applyCodexPlan, codexFingerprint, planCodex } from "../../src/desktop/codex.js";
import { tmpHome } from "../helpers/tmp-home.js";

const MCP = { command: "node", args: ["/abs/mcp/index.js"] };
const BRAIN = { preset: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-codex-000000000000", model: "gpt-6-sol" };
const WALLET = { server: "http://127.0.0.1:18420", key: "mk_live_childAAAAAAAAAAAAAAAAAAAA" };

const USER_CONFIG = `model = "gpt-6-sol"
model_reasoning_effort = "xhigh"

[projects.'C:\\Users\\me']
trust_level = "trusted"

[mcp_servers.other]
command = "node"
args = ["x.js"]
`;

function setup(content: string | null) {
  const { home, env } = tmpHome();
  const file = path.join(home, ".codex", "config.toml");
  if (content !== null) fs.writeFileSync(file, content);
  return { home, env, file };
}

describe("codex config: diff, write, backup, restore", () => {
  it("preview lists every field it will change, with secrets masked, and writes nothing", () => {
    const { env, file } = setup(USER_CONFIG);
    const { plan } = planCodex(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null);
    expect(fs.readFileSync(file, "utf8")).toBe(USER_CONFIG);
    const changes = plan.files[0].changes;
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect(byField.model).toBeUndefined(); // same model -> not listed
    expect(byField.model_provider).toMatchObject({ op: "add", before: null, after: "moneyswitch_brain" });
    expect(byField["[model_providers.moneyswitch_brain].base_url"].after).toBe("https://api.openai.com/v1");
    expect(byField["[model_providers.moneyswitch_brain].wire_api"].after).toBe("responses");
    const tok = byField["[model_providers.moneyswitch_brain].experimental_bearer_token"];
    expect(tok.secret).toBe(true);
    expect(tok.after).not.toContain("000000000000");
    const key = byField["[mcp_servers.moneyswitch.env].MONEY_API_KEY"];
    expect(key.after).toMatch(/^mk_live_chil…AAAA$/);
    expect(JSON.stringify(plan)).not.toContain(WALLET.key);
    expect(JSON.stringify(plan)).not.toContain(BRAIN.apiKey);
  });

  it("enable backs up, writes only managed keys, reads back; disable restores the original bytes", () => {
    const { env, file } = setup(USER_CONFIG);
    const now = new Date("2026-09-26T01:00:00Z");
    const r = applyCodexPlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null, now);
    expect(r.backups).toEqual([`${file}.bak-${now.getTime()}`]);
    expect(fs.readFileSync(r.backups[0], "utf8")).toBe(USER_CONFIG);
    const doc = parse(fs.readFileSync(file, "utf8")) as any;
    expect(doc.model_provider).toBe("moneyswitch_brain");
    expect(doc.model_providers.moneyswitch_brain).toMatchObject({ base_url: BRAIN.baseUrl, wire_api: "responses", experimental_bearer_token: BRAIN.apiKey });
    expect(doc.mcp_servers.moneyswitch).toMatchObject({ command: "node", args: MCP.args, env: { MONEY_API_BASE: WALLET.server, MONEY_API_KEY: WALLET.key } });
    expect(doc.mcp_servers.other).toEqual({ command: "node", args: ["x.js"] });
    expect(doc.projects).toEqual({ "C:\\Users\\me": { trust_level: "trusted" } });
    expect(doc.model_reasoning_effort).toBe("xhigh");

    const applied = r.applied!;
    expect(codexFingerprint(env, applied)).toBe(applied.fingerprint);

    const off = applyCodexPlan(env, "disable", null, applied, new Date("2026-09-26T02:00:00Z"));
    expect(off.applied).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(USER_CONFIG);
  });

  it("re-enable with a new key keeps the ORIGINAL previous values for the final restore", () => {
    const withProvider = `model = "o3"\nmodel_provider = "azure"\n\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://x.openai.azure.com/openai"\n`;
    const { env, file } = setup(withProvider);
    const first = applyCodexPlan(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null);
    const second = applyCodexPlan(env, "enable", { brain: { ...BRAIN, apiKey: "sk-second-key-111111111111", model: "gpt-5-codex" }, wallet: WALLET, mcpCommand: MCP }, first.applied);
    expect((parse(fs.readFileSync(file, "utf8")) as any).model).toBe("gpt-5-codex");
    applyCodexPlan(env, "disable", null, second.applied);
    const back = parse(fs.readFileSync(file, "utf8")) as any;
    expect(back.model).toBe("o3");
    expect(back.model_provider).toBe("azure");
    expect(back.model_providers.azure.name).toBe("Azure");
    expect(back.model_providers.moneyswitch_brain).toBeUndefined();
    expect(back.mcp_servers).toBeUndefined();
  });

  it("replaces an existing [mcp_servers.moneyswitch] (e.g. from `moneyswitch connect`) and puts it back on disable", () => {
    const connectWritten = `${USER_CONFIG}\n[mcp_servers.moneyswitch]\ncommand = "npx"\nargs = ["-y", "moneyswitch", "mcp"]\n\n[mcp_servers.moneyswitch.env]\nMONEY_API_BASE = "http://s"\nMONEY_API_KEY = "mk_live_parentkey0000000000"\n`;
    const { env, file } = setup(connectWritten);
    const on = applyCodexPlan(env, "enable", { brain: null, wallet: WALLET, mcpCommand: MCP }, null);
    expect((parse(fs.readFileSync(file, "utf8")) as any).mcp_servers.moneyswitch.env.MONEY_API_KEY).toBe(WALLET.key);
    applyCodexPlan(env, "disable", null, on.applied);
    expect((parse(fs.readFileSync(file, "utf8")) as any).mcp_servers.moneyswitch.env.MONEY_API_KEY).toBe("mk_live_parentkey0000000000");
  });

  it("creates config.toml when missing and removes it again on disable", () => {
    const { env, file } = setup(null);
    const on = applyCodexPlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null);
    expect(on.backups).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    applyCodexPlan(env, "disable", null, on.applied);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses to touch an unparseable config.toml", () => {
    const { env, file } = setup("model = \n[[broken");
    expect(() => planCodex(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null)).toThrow(/not valid TOML/);
    expect(() => applyCodexPlan(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null)).toThrow(/not valid TOML/);
    expect(fs.readFileSync(file, "utf8")).toBe("model = \n[[broken");
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("refuses (and writes nothing) when the line editor would corrupt an unusual layout", () => {
    // An array-of-arrays line looks like a table header to a line scanner.
    const tricky = `arr = [
  ["x"]
]

[a]
b = 1
`;
    const { env, file } = setup(tricky);
    expect(() => planCodex(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null)).toThrow(/refusing to write/);
    expect(() => applyCodexPlan(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null)).toThrow(/refusing to write/);
    expect(fs.readFileSync(file, "utf8")).toBe(tricky);
  });

  it("detects external edits via the fingerprint (status: drifted)", () => {
    const { env, file } = setup(USER_CONFIG);
    const on = applyCodexPlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(WALLET.key, "mk_live_someoneelse000000000"));
    expect(codexFingerprint(env, on.applied!)).not.toBe(on.applied!.fingerprint);
  });

  it("DeepSeek preset carries the Responses-API warning", () => {
    const { env } = setup(USER_CONFIG);
    const { plan } = planCodex(env, "enable", { brain: { ...BRAIN, preset: "deepseek" }, wallet: null, mcpCommand: MCP }, null);
    expect(plan.warnings).toContain("codexNeedsResponsesApi");
  });
});
