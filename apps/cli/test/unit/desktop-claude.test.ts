import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyClaudePlan, claudeFingerprint, claudeManagedKeys, planClaude } from "../../src/desktop/claude.js";
import { FakeAgentRunner } from "../helpers/fake-claude.js";
import { tmpHome } from "../helpers/tmp-home.js";

const MCP = { command: "node", args: ["/abs/mcp/index.js"] };
const BRAIN = { preset: "openrouter", baseUrl: "https://openrouter.ai/api", apiKey: "sk-or-test-000000000000", model: "anthropic/claude-sonnet-4.5" };
const WALLET = { server: "http://127.0.0.1:18420", key: "mk_live_childBBBBBBBBBBBBBBBBBBBB" };
const SETTINGS = { env: { ANTHROPIC_API_KEY: "sk-ant-original-0000", OTHER: "keep" }, permissions: { allow: ["Bash(ls)"] } };

function setup(settings: object | null, claudeJson: object | null = { numStartups: 3 }) {
  const { home, env } = tmpHome();
  const settingsFile = path.join(home, ".claude", "settings.json");
  const jsonFile = path.join(home, ".claude.json");
  if (settings) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  if (claudeJson) fs.writeFileSync(jsonFile, JSON.stringify(claudeJson, null, 2));
  return { home, env, settingsFile, jsonFile, runner: new FakeAgentRunner(home) };
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("claude code config: diff, write, backup, restore", () => {
  it("preview shows settings.json env fields + the mcp entry, masked, and changes nothing", () => {
    const { env, settingsFile, jsonFile } = setup(SETTINGS);
    const before = fs.readFileSync(settingsFile, "utf8");
    const { plan } = planClaude(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(before);
    const [settingsPlan, jsonPlan] = plan.files;
    expect(settingsPlan.display).toBe("~/.claude/settings.json");
    const f = Object.fromEntries(settingsPlan.changes.map((c) => [c.field, c]));
    expect(f["env.ANTHROPIC_BASE_URL"]).toMatchObject({ op: "add", after: "https://openrouter.ai/api" });
    expect(f["env.ANTHROPIC_AUTH_TOKEN"]).toMatchObject({ op: "add", secret: true });
    // OpenRouter uses the Bearer var, so a conflicting x-api-key var is removed (and restored later).
    expect(f["env.ANTHROPIC_API_KEY"]).toMatchObject({ op: "remove", after: null });
    expect(f["env.ANTHROPIC_MODEL"].after).toBe("anthropic/claude-sonnet-4.5");
    expect(jsonPlan.display).toBe("~/.claude.json");
    expect(jsonPlan.writer).toBe("agent-cli");
    expect(plan.commands.map((c) => c.display).join("\n")).toContain("claude mcp add moneyswitch -s user -e MONEY_API_BASE=http://127.0.0.1:18420 -e MONEY_API_KEY=mk_live_chil…BBBB -- node /abs/mcp/index.js");
    const s = JSON.stringify(plan);
    expect(s).not.toContain(WALLET.key);
    expect(s).not.toContain(BRAIN.apiKey);
    expect(s).not.toContain("sk-ant-original-0000");
    expect(fs.existsSync(jsonFile)).toBe(true);
    expect(read(jsonFile).mcpServers).toBeUndefined();
  });

  it("enable: backs up both files, writes env + runs claude mcp add; disable restores exactly", () => {
    const { env, settingsFile, jsonFile, runner } = setup(SETTINGS);
    const now = new Date("2026-09-26T03:00:00Z");
    const on = applyClaudePlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null, runner, now);
    expect(on.backups.sort()).toEqual([`${jsonFile}.bak-${now.getTime()}`, `${settingsFile}.bak-${now.getTime()}`].sort());
    const s = read(settingsFile);
    expect(s.env).toEqual({
      OTHER: "keep",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: BRAIN.apiKey,
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.5",
    });
    expect(s.permissions).toEqual(SETTINGS.permissions);
    expect(read(jsonFile).mcpServers.moneyswitch).toEqual({ type: "stdio", command: "node", args: MCP.args, env: { MONEY_API_BASE: WALLET.server, MONEY_API_KEY: WALLET.key } });
    expect(read(jsonFile).numStartups).toBe(3);
    expect(runner.calls).toContain("claude mcp remove moneyswitch -s user");

    const applied = on.applied!;
    expect(claudeFingerprint(env, claudeManagedKeys(applied), true)).toBe(applied.fingerprint);

    applyClaudePlan(env, "disable", null, applied, runner);
    expect(read(settingsFile)).toEqual(SETTINGS);
    expect(read(jsonFile).mcpServers).toEqual({});
  });

  it("rolls back settings.json when `claude mcp add` fails", () => {
    const { env, settingsFile, runner } = setup(SETTINGS);
    const before = fs.readFileSync(settingsFile, "utf8");
    runner.failAdd = true;
    expect(() => applyClaudePlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null, runner)).toThrow(/claude mcp add failed/);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(before);
  });

  it("reports NOT_INSTALLED and rolls back when claude is missing", () => {
    const { home, env, settingsFile } = setup(SETTINGS);
    const runner = new FakeAgentRunner(home, ["codex"]);
    const before = fs.readFileSync(settingsFile, "utf8");
    try {
      applyClaudePlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null, runner);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("NOT_INSTALLED");
    }
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(before);
  });

  it("puts a pre-existing moneyswitch MCP entry back on disable (and warns in the preview)", () => {
    const prior = { mcpServers: { moneyswitch: { type: "stdio", command: "npx", args: ["-y", "moneyswitch", "mcp"], env: { MONEY_API_BASE: "http://s", MONEY_API_KEY: "mk_live_parent00000000000000" } } } };
    const { env, jsonFile, runner } = setup(null, prior);
    const { plan } = planClaude(env, "enable", { brain: null, wallet: WALLET, mcpCommand: MCP }, null);
    expect(plan.warnings).toContain("claudeReplacesExistingMcp");
    const on = applyClaudePlan(env, "enable", { brain: null, wallet: WALLET, mcpCommand: MCP }, null, runner);
    expect(read(jsonFile).mcpServers.moneyswitch.env.MONEY_API_KEY).toBe(WALLET.key);
    const { plan: off } = planClaude(env, "disable", null, on.applied);
    expect(off.commands.map((c) => c.why)).toEqual(["remove", "restore"]);
    applyClaudePlan(env, "disable", null, on.applied, runner);
    expect(read(jsonFile).mcpServers.moneyswitch).toEqual(prior.mcpServers.moneyswitch);
  });

  it("settings.json that did not exist is removed again on disable", () => {
    const { env, settingsFile, runner } = setup(null);
    const on = applyClaudePlan(env, "enable", { brain: { ...BRAIN, preset: "anthropic", baseUrl: "https://api.anthropic.com" }, wallet: null, mcpCommand: MCP }, null, runner);
    expect(read(settingsFile).env.ANTHROPIC_API_KEY).toBe(BRAIN.apiKey);
    applyClaudePlan(env, "disable", null, on.applied, runner);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it("refuses to write when settings.json is not valid JSON", () => {
    const { env, settingsFile, runner } = setup(null);
    fs.writeFileSync(settingsFile, "{ not json");
    expect(() => planClaude(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null)).toThrow(/not valid JSON/);
    expect(() => applyClaudePlan(env, "enable", { brain: BRAIN, wallet: null, mcpCommand: MCP }, null, runner)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe("{ not json");
  });

  it("an external edit of a managed value changes the fingerprint (drifted)", () => {
    const { env, settingsFile, runner } = setup(SETTINGS);
    const on = applyClaudePlan(env, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null, runner);
    const s = read(settingsFile);
    s.env.ANTHROPIC_MODEL = "something-else";
    fs.writeFileSync(settingsFile, JSON.stringify(s));
    expect(claudeFingerprint(env, claudeManagedKeys(on.applied!), true)).not.toBe(on.applied!.fingerprint);
  });

  it("honours CLAUDE_CONFIG_DIR for both settings.json and .claude.json", () => {
    const { home, env } = setup(null, null);
    const dir = path.join(home, "alt-claude");
    fs.mkdirSync(dir);
    const e2 = { ...env, CLAUDE_CONFIG_DIR: dir };
    const { plan } = planClaude(e2, "enable", { brain: BRAIN, wallet: WALLET, mcpCommand: MCP }, null);
    expect(plan.files.map((f) => f.display)).toEqual(["~/alt-claude/settings.json", "~/alt-claude/.claude.json"]);
  });
});
