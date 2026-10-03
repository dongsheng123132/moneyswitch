// Regression: a server started from PowerShell 7 passes PS7's PSModulePath on to Windows PowerShell 5.1, which then
// auto-loads the wrong Microsoft.PowerShell.Security and every cmdlet from it (Get-Acl) fails. GitHub's windows-latest
// runner runs `pnpm test` under pwsh 7, which is how this was found (CI run 37161299134: "could not set the ACL
// (PowerShell): #< CLIXML"). Pure helpers are tested everywhere; the real reproduction only on Windows.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProtector, powerShellEnv, readableStderr } from "../src/protect.js";

vi.setConfig({ testTimeout: 90_000 });

describe("readableStderr", () => {
  it("returns the first line of plain stderr", () => {
    expect(readableStderr("Access is denied.\r\nmore")).toBe("Access is denied.");
  });
  it("decodes PowerShell CLIXML error records instead of reporting '#< CLIXML'", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">' +
      "Get-Acl : The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded._x000D__x000A_" +
      '</S><S S="Error">At line:1 char:1 &amp; more_x000D__x000A_</S></Objs>';
    const text = readableStderr(clixml);
    expect(text).toContain("The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security'");
    expect(text).toContain("At line:1 char:1 & more");
    expect(text).not.toContain("CLIXML");
    expect(text).not.toContain("_x000D_");
  });
  it("never returns an empty reason for CLIXML without error records", () => {
    expect(readableStderr('#< CLIXML\r\n<Objs Version="1.1.0.1"></Objs>')).toBe("PowerShell reported an error");
  });
});

describe("powerShellEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  it("drops PSModulePath in any spelling, keeps everything else and adds the extras", () => {
    process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
    process.env.PSMODULEPATH_SHADOW_TEST = "kept"; // a different name, must survive
    const env = powerShellEnv({ MS_ACL_PATHS: "a|b" });
    expect(Object.keys(env).some((k) => k.toLowerCase() === "psmodulepath")).toBe(false);
    expect(env.PSMODULEPATH_SHADOW_TEST).toBe("kept");
    expect(env.MS_ACL_PATHS).toBe("a|b");
    expect(env.PATH ?? env.Path).toBeDefined();
  });
});

// The real thing: PowerShell 7's own module path (it lists PS7's Microsoft.PowerShell.Security first). Needs pwsh installed,
// as on GitHub's windows-latest runner; skipped where it is not.
function pwsh7ModulePath(): string | null {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath"], { encoding: "utf-8", timeout: 60_000 }).trim() || null;
  } catch {
    return null;
  }
}
const PWSH7_PATH = pwsh7ModulePath();

describe.runIf(PWSH7_PATH !== null)("Windows: protection works when the server inherits PowerShell 7's module path", () => {
  const saved = process.env.PSModulePath;
  let root = "";
  afterEach(() => {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("sets and reads back the ACL with PS7's PSModulePath in the environment (as when started from pwsh)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-pwsh7-"));
    process.env.PSModulePath = PWSH7_PATH!;
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "wallet-unlock-0xabc.secret"), "x");
    const result = await defaultProtector()({ dir, file: path.join(dir, "wallet-unlock-0xabc.secret") });
    expect(result).toEqual({ ok: true, method: "acl" });
  });
});
