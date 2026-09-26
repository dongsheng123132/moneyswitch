import path from "node:path";
import os from "node:os";

/**
 * Every path the desktop console reads or writes is derived from an explicit
 * `env`, never from the ambient process state, so tests (and the Playwright
 * walkthrough) can point HOME / USERPROFILE / CODEX_HOME / CLAUDE_CONFIG_DIR
 * at a throwaway directory and be certain nothing real is touched.
 */
export function homeDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    if (env.USERPROFILE) return env.USERPROFILE;
    if (env.HOME) return env.HOME;
  } else if (env.HOME) {
    return env.HOME;
  }
  return os.homedir();
}

/** Claude Code keeps settings.json (and, with CLAUDE_CONFIG_DIR, .claude.json) here. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(homeDir(env), ".claude");
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return path.join(claudeConfigDir(env), "settings.json");
}

/**
 * Where `claude mcp add -s user` stores user-scope MCP servers: ~/.claude.json,
 * or $CLAUDE_CONFIG_DIR/.claude.json when that is set (verified against
 * Claude Code 2.1.280, see docs/desktop-agents.md).
 */
export function claudeJsonPath(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(homeDir(env), ".claude.json");
}

export function codexConfigFile(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME ? env.CODEX_HOME : path.join(homeDir(env), ".codex");
  return path.join(home, "config.toml");
}


export function desktopDir(env: NodeJS.ProcessEnv): string {
  return path.join(homeDir(env), ".moneyswitch");
}

export function desktopStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(desktopDir(env), "desktop.json");
}

/** Display form: replace the home prefix with "~" so the UI stays short and never leaks the user name. */
export function displayPath(p: string, env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  const norm = (s: string) => s.replace(/\\/g, "/");
  const np = norm(p);
  const nh = norm(home).replace(/\/+$/, "");
  if (np.toLowerCase().startsWith(nh.toLowerCase() + "/")) return "~" + np.slice(nh.length);
  return np;
}
