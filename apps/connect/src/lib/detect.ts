import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandRunner } from "./runner.js";

/**
 * SPEC-v0.3-employee.md §B.2 step 2: probe locally installed agents without
 * modifying anything.
 */
export function detectClaude(runner: CommandRunner): boolean {
  const res = runner.run("claude", ["--version"]);
  return res.ok;
}

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return path.join(os.homedir(), ".codex");
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexHomeDir(env), "config.toml");
}

export function detectCodex(runner: CommandRunner, env: NodeJS.ProcessEnv = process.env): boolean {
  const inPath = runner.run("codex", ["--version"]).ok;
  const dirExists = fs.existsSync(codexHomeDir(env));
  return inPath || dirExists;
}
