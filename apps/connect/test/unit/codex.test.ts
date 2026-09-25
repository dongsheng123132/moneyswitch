import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCodexConfig,
  removeCodexConfig,
  removeMoneySwitchSection,
  hasMoneySwitchSection,
} from "../../src/lib/codex.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ms-connect-codex-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("codex config writer (SPEC-v0.3-employee.md §B.2 step 3, §B.4)", () => {
  it("creates config.toml when none exists (no backup)", () => {
    const dir = tmpDir();
    const cfgPath = path.join(dir, "config.toml");
    const res = applyCodexConfig(cfgPath, "http://127.0.0.1:4020", "mk_live_abcdefgh", {
      command: "node",
      args: ["/abs/path/to/mcp/dist/index.js"],
    });
    expect(res.existed).toBe(false);
    expect(res.backupPath).toBeNull();
    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.moneyswitch]");
    expect(text).toContain('command = "node"');
    expect(text).toContain("mk_live_abcdefgh");
    expect(text).toContain("http://127.0.0.1:4020");
  });

  it("preserves unrelated sections and backs up + replaces an existing moneyswitch section", () => {
    const dir = tmpDir();
    const cfgPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      cfgPath,
      [
        "[mcp_servers.other]",
        'command = "python"',
        "",
        "[mcp_servers.moneyswitch]",
        'command = "node"',
        'args = ["/old/path.js"]',
        "",
        "[mcp_servers.moneyswitch.env]",
        'MONEY_API_BASE = "http://old"',
        'MONEY_API_KEY = "mk_live_old"',
        "",
      ].join("\n"),
      "utf8"
    );

    const res = applyCodexConfig(cfgPath, "http://127.0.0.1:4020", "mk_live_new", { command: "node", args: ["/new/path.js"] });
    expect(res.existed).toBe(true);
    expect(res.backupPath).toBeTruthy();
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    expect(fs.readFileSync(res.backupPath!, "utf8")).toContain("mk_live_old");

    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain('command = "python"');
    expect(text).not.toContain("mk_live_old");
    expect(text).not.toContain("/old/path.js");
    expect(text).toContain("mk_live_new");
    expect(text).toContain("/new/path.js");
    // only one moneyswitch table left
    expect(text.match(/\[mcp_servers\.moneyswitch\]/g)?.length).toBe(1);
  });

  it("removeCodexConfig strips only the moneyswitch section and backs up", () => {
    const dir = tmpDir();
    const cfgPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      cfgPath,
      ["[mcp_servers.other]", 'command = "python"', "", "[mcp_servers.moneyswitch]", 'command = "node"', ""].join("\n"),
      "utf8"
    );
    const res = removeCodexConfig(cfgPath);
    expect(res.removed).toBe(true);
    expect(res.backupPath).toBeTruthy();
    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("moneyswitch");
  });

  it("removeCodexConfig is a no-op when file doesn't exist", () => {
    const dir = tmpDir();
    const cfgPath = path.join(dir, "config.toml");
    const res = removeCodexConfig(cfgPath);
    expect(res.removed).toBe(false);
    expect(res.backupPath).toBeNull();
  });

  it("removeCodexConfig is a no-op when section absent", () => {
    const dir = tmpDir();
    const cfgPath = path.join(dir, "config.toml");
    fs.writeFileSync(cfgPath, '[mcp_servers.other]\ncommand = "python"\n', "utf8");
    const res = removeCodexConfig(cfgPath);
    expect(res.removed).toBe(false);
    expect(res.backupPath).toBeNull();
  });

  it("hasMoneySwitchSection / removeMoneySwitchSection helpers", () => {
    const text = "[a]\nx=1\n[mcp_servers.moneyswitch.env]\nY=2\n[b]\nz=3\n";
    expect(hasMoneySwitchSection(text)).toBe(true);
    const stripped = removeMoneySwitchSection(text);
    expect(stripped).toContain("[a]");
    expect(stripped).toContain("[b]");
    expect(stripped).not.toContain("moneyswitch");
  });
});
