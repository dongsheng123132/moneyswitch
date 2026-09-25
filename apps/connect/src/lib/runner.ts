import { spawnSync } from "node:child_process";

/**
 * SPEC-v0.3-employee.md §B.4: Claude Code integration must be testable via
 * an injectable command executor instead of really invoking `claude`.
 */
export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[]): CommandResult;
}

export class RealCommandRunner implements CommandRunner {
  run(cmd: string, args: string[]): CommandResult {
    try {
      const res = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
      if (res.error) {
        return { ok: false, code: null, stdout: "", stderr: String(res.error.message ?? res.error) };
      }
      return {
        ok: (res.status ?? 1) === 0,
        code: res.status,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
      };
    } catch (e) {
      return { ok: false, code: null, stdout: "", stderr: (e as Error).message };
    }
  }
}
