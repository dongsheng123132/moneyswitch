#!/usr/bin/env node
/**
 * mirror-push.mjs — push MoneySwitch to alternative code-hosting mirrors.
 *
 * Usage:
 *   node scripts/mirror-push.mjs              # push all configured remotes
 *   node scripts/mirror-push.mjs --only gitee # push one remote
 *   node scripts/mirror-push.mjs --dry-run    # show what would happen
 *   node scripts/mirror-push.mjs --setup      # add remote URLs to local git config
 *
 * Configuration: scripts/mirror.config.json (copy from mirror.config.example.json).
 * Tokens are read from environment variables — NEVER commit them.
 *
 * China-platform remotes (gitee / gitcode / cnb) get README.cn-mirror.md
 * swapped in as README.md before push, then the original is restored.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(__dirname, "mirror.config.json");
const CONFIG_EXAMPLE = join(__dirname, "mirror.config.example.json");
const CN_README = join(ROOT, "README.cn-mirror.md");
const README = join(ROOT, "README.md");
const README_BACKUP = join(ROOT, "README.github-backup.md");

// ---------- CLI ----------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const setup = args.includes("--setup");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

function git(...cmds) {
  return execFileSync("git", cmds, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitInherit(...cmds) {
  execFileSync("git", cmds, { cwd: ROOT, stdio: "inherit" });
}

// ---------- config ----------
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Missing ${CONFIG_PATH}`);
    console.error(`Copy ${CONFIG_EXAMPLE} → mirror.config.json and fill in repo paths.`);
    console.error("Tokens go in environment variables, not the config file.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/**
 * Expected shape of mirror.config.json:
 * {
 *   "remotes": [
 *     {
 *       "name": "gitee",
 *       "host": "gitee.com",
 *       "repo": "yourname/moneyswitch",
 *       "cn": true,
 *       "tokenEnv": "GITEE_TOKEN"
 *     },
 *     ...
 *   ]
 * }
 *
 * "cn": true  → swap in README.cn-mirror.md before push
 * "tokenEnv"  → name of env var holding a token (or password / PAT)
 * If tokenEnv is omitted or the env var is empty, auth falls back to
 * whatever git credential helper is configured (e.g. Windows Credential Manager).
 */

function remoteUrl(r, token) {
  if (token) {
    // oauth2: is accepted by Gitee / GitLab / GitCode / CNB.
    // Codeberg (Forgejo) accepts either oauth2: or plain username:token.
    const auth = r.host === "codeberg.org" ? token : `oauth2:${token}`;
    return `https://${auth}@${r.host}/${r.repo}.git`;
  }
  return `https://${r.host}/${r.repo}.git`;
}

// ---------- README swap ----------
function swapInCnReadme() {
  if (!existsSync(CN_README)) {
    console.error(`Missing ${CN_README} — cannot push to China platforms.`);
    process.exit(1);
  }
  copyFileSync(README, README_BACKUP);
  copyFileSync(CN_README, README);
  console.log("  README.md ← README.cn-mirror.md (audit-safe)");
}

function restoreReadme() {
  if (existsSync(README_BACKUP)) {
    copyFileSync(README_BACKUP, README);
    unlinkSync(README_BACKUP);
    console.log("  README.md restored");
  }
}

// ---------- push ----------
function pushRemote(r, { isSetup }) {
  const token = r.tokenEnv ? process.env[r.tokenEnv] || "" : "";
  const url = remoteUrl(r, token);
  const safeUrl = remoteUrl(r, token ? "***" : "");
  const cn = !!r.cn;

  console.log(`\n[${r.name}] ${safeUrl}${cn ? "  (CN-safe README)" : ""}`);

  if (isSetup) {
    if (dryRun) {
      console.log(`  dry-run: git remote add ${r.name} ${safeUrl}`);
      return;
    }
    try {
      git("remote", "get-url", r.name);
      git("remote", "set-url", r.name, url);
      console.log(`  remote '${r.name}' updated`);
    } catch {
      git("remote", "add", r.name, url);
      console.log(`  remote '${r.name}' added`);
    }
    return;
  }

  if (dryRun) {
    console.log(`  dry-run: git push ${r.name} HEAD:refs/heads/main --force`);
    console.log(`  dry-run: git push ${r.name} --tags --force`);
    return;
  }

  // Ensure remote exists (local push path).
  try {
    git("remote", "get-url", r.name);
  } catch {
    git("remote", "add", r.name, url);
    console.log(`  remote '${r.name}' added`);
  }

  if (cn) swapInCnReadme();
  try {
    // Commit the swapped README so the pushed tree is consistent.
    if (cn) {
      gitInherit("add", "README.md");
      gitInherit(
        "commit",
        "-m",
        "docs: China-mirror README (audit-safe wording)",
        "--allow-empty",
        "--no-verify"
      );
    }
    gitInherit("push", r.name, "HEAD:refs/heads/main", "--force");
    gitInherit("push", r.name, "--tags", "--force");
    console.log(`  pushed main + tags`);
  } finally {
    if (cn) {
      // Undo the temporary commit and restore README.
      // Keep it simple: reset soft to HEAD~1 then checkout README.
      try {
        gitInherit("reset", "--soft", "HEAD~1");
        gitInherit("reset", "HEAD", "README.md");
      } catch {
        /* if commit was empty / already clean, ignore */
      }
      restoreReadme();
    }
  }
}

// ---------- main ----------
function main() {
  const config = loadConfig();
  const remotes = config.remotes.filter((r) => !only || r.name === only);

  if (remotes.length === 0) {
    console.error(only ? `No remote named '${only}' in config.` : "No remotes configured.");
    process.exit(1);
  }

  console.log(
    `mirror-push ${setup ? "--setup" : "--push"}${dryRun ? " --dry-run" : ""}${only ? ` --only ${only}` : ""}`
  );
  console.log(`branch: ${git("rev-parse", "--abbrev-ref", "HEAD")}  commit: ${git("rev-parse", "--short", "HEAD")}`);

  for (const r of remotes) {
    try {
      pushRemote(r, { isSetup: setup });
    } catch (err) {
      console.error(`  [${r.name}] FAILED: ${err.message || err}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    console.error("\nSome mirrors failed. Fix and re-run.");
  } else {
    console.log("\nDone.");
  }
}

// Always restore README if anything throws mid-swap.
process.on("exit", () => {
  try {
    restoreReadme();
  } catch {
    /* ignore */
  }
});

main();
