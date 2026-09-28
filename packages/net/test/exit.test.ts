import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures", "exit-after-install-fetch.mjs");

/**
 * Regression test for a Windows-only (Node 24.19) crash: after
 * installOutboundProxy() and a couple of successful fetches (one routed
 * through the ProxyAgent, one direct), the process crashed on its own,
 * natural exit with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\win\async.c" (exit code 127) — even though every fetch had
 * already completed and printed. Runs the fixture as a real child process
 * (not in-process) because the bug is specifically about *process* exit,
 * which only a real spawn can observe; asserts exit code 0 with no signal,
 * which should hold on every platform (the bug was Windows-specific, but a
 * clean exit is the expected behavior everywhere).
 */
describe("process exit after installOutboundProxy() + fetch", () => {
  it("exits with code 0 and no signal, on a natural (non-process.exit) exit", async () => {
    const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    expect({ code, signal, stdout, stderr }).toMatchObject({ code: 0, signal: null });
    expect(stderr).not.toMatch(/Assertion failed/);

    const line = JSON.parse(stdout.trim());
    expect(line.resolutionSource).toBe("MONEYSWITCH_PROXY");
    expect(line.viaProxyStatus).toBe(200);
    expect(line.viaProxyBody).toBe("ok-from-target");
    expect(line.directStatus).toBe(200);
    expect(line.directBody).toBe("ok-from-target");
  }, 20000);
});
