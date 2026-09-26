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

export interface RealCommandRunnerOptions {
  /**
   * Environment for the child process (default: this process's env).
   * SPEC-v0.4 §B: the desktop console passes an isolated HOME/USERPROFILE/
   * CODEX_HOME here in tests, so `claude mcp add` writes into the temp home
   * instead of the real ~/.claude.json.
   */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Quote one argument for cmd.exe. On Windows `claude`/`codex` are `.cmd`
 * shims, so they have to go through a shell, which concatenates argv
 * verbatim; anything with spaces or cmd metacharacters must be quoted or it
 * gets split / interpreted.
 */
export function quoteWinArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export class RealCommandRunner implements CommandRunner {
  constructor(private readonly opts: RealCommandRunnerOptions = {}) {}

  run(cmd: string, args: string[]): CommandResult {
    const win = process.platform === "win32";
    try {
      const res = win
        ? spawnSync([cmd, ...args].map(quoteWinArg).join(" "), {
            encoding: "utf8",
            shell: true,
            env: this.opts.env ?? process.env,
            cwd: this.opts.cwd,
            timeout: this.opts.timeoutMs,
          })
        : spawnSync(cmd, args, {
            encoding: "utf8",
            env: this.opts.env ?? process.env,
            cwd: this.opts.cwd,
            timeout: this.opts.timeoutMs,
          });
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
