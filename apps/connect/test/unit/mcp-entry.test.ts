import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveMcpCommand } from "../../src/lib/mcp-entry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveMcpCommand (portable vs in-repo MCP launch command)", () => {
  it("uses `node <resolved @moneyswitch/mcp path>` when the workspace package resolves (in-repo dev mode)", () => {
    const cmd = resolveMcpCommand(import.meta.url);
    expect(cmd.command).toBe("node");
    expect(cmd.args).toHaveLength(1);
    expect(cmd.args[0]).toMatch(/mcp[\\/]dist[\\/]index\.js$/);
  });

  it("falls back to the portable `npx -y moneyswitch mcp` when @moneyswitch/mcp cannot be resolved (e.g. from the published moneyswitch package)", () => {
    // Run in a real child `node` process (not through vitest's own module
    // resolver, which resolves workspace packages regardless of the calling
    // directory) against the compiled dist output, from a real directory
    // outside the repo/pnpm workspace with no node_modules ancestor
    // containing @moneyswitch/mcp. require.resolve there throws
    // MODULE_NOT_FOUND — the same real condition that occurs when this code
    // runs as part of the published `moneyswitch` npm package, which does
    // not depend on a separate @moneyswitch/mcp.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-connect-mcp-entry-"));
    dirs.push(dir);
    const fakeFile = path.join(dir, "probe.mjs");
    const mcpEntryDistUrl = pathToFileURL(path.resolve(__dirname, "../../dist/lib/mcp-entry.js")).href;
    fs.writeFileSync(
      fakeFile,
      [
        `import { resolveMcpCommand } from ${JSON.stringify(mcpEntryDistUrl)};`,
        `import { pathToFileURL } from "node:url";`,
        `const url = pathToFileURL(${JSON.stringify(fakeFile)}).href;`,
        `console.log(JSON.stringify(resolveMcpCommand(url)));`,
      ].join("\n"),
      "utf8"
    );
    // NODE_PATH must be cleared: vitest's own worker process injects a
    // NODE_PATH pointing at pnpm's hoisted node_modules, which would let
    // Node's module resolution fall back to finding @moneyswitch/mcp there
    // even from an unrelated directory — an artifact of the test runner,
    // not something a real `npx`/installed `moneyswitch` process would have.
    const { NODE_PATH, ...envWithoutNodePath } = process.env;
    const res = spawnSync(process.execPath, [fakeFile], { encoding: "utf8", env: envWithoutNodePath });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ command: "npx", args: ["-y", "moneyswitch", "mcp"] });
  });
});
