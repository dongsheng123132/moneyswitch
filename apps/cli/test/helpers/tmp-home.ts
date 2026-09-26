import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * A throwaway home under <repo>/.data/desktop/unit/ (gitignored) plus the env
 * that points every agent path into it. Nothing in the tests may touch the
 * real ~/.claude*, ~/.codex or ~/.moneyswitch.
 */
export function tmpHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = path.join(repo, ".data", "desktop", "unit", `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CODEX_HOME: path.join(home, ".codex"),
    USERNAME: process.env.USERNAME,
    USERDOMAIN: process.env.USERDOMAIN,
  };
  return { home, env };
}
