import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * `moneyswitch demo` — thin launcher for the offline demo, which lives in the
 * separate, AGPL-3.0-only `moneyswitch-server` npm package. This Apache-2.0
 * CLI never bundles or links that code: it only runs
 *   npx -y moneyswitch-server@<this CLI's version> demo [args…]
 * as a child process (MONEYSWITCH_SERVER_SPEC overrides the package spec, e.g.
 * a local .tgz for testing before it is published).
 */

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

export const DEMO_HELP = `moneyswitch demo — 30-second offline tour of MoneySwitch (no real money)

Usage:
  moneyswitch demo [--port 4020] [--no-open] [--registry=<url>]

Runs "npx -y moneyswitch-server@<version> demo": it DOWNLOADS the separate
moneyswitch-server npm package (the self-hostable server + Dashboard,
licensed AGPL-3.0-only; this CLI is Apache-2.0) and starts a throwaway local
server with a mock wallet, demo keys, a toll booth and simulated payments,
then opens the Dashboard signed in. Ctrl+C stops it and deletes the data.
Needs Node.js 22 or newer.

Options (passed through to "moneyswitch-server demo"):
  --port <n>          first port to try (free ports are picked automatically)
  --no-open           print the link instead of opening a browser
  --registry=<url>    npm registry to download from (default: your npm config).
                      If a mirror has not synced the package yet, use
                      --registry=${OFFICIAL_REGISTRY}

Environment:
  MONEYSWITCH_SERVER_SPEC   package spec to run instead of
                            moneyswitch-server@<version> (e.g. a local .tgz path)

Self-host the full server instead: npx moneyswitch-server`;

export interface DemoInvocation {
  spec: string;
  /** Registry passed explicitly on the command line (goes to npx, not the demo). */
  registry: string | null;
  /** Arguments for npx (without the npx binary itself). */
  npxArgs: string[];
  help: boolean;
}

/** Pure: argv after "demo" + env + this CLI's version -> what to run. */
export function buildDemoInvocation(args: string[], env: NodeJS.ProcessEnv, version: string): DemoInvocation {
  const passthrough: string[] = [];
  let registry: string | null = null;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a.startsWith("--registry=")) {
      registry = a.slice("--registry=".length);
    } else if (a === "--registry") {
      registry = args[++i] ?? null;
    } else {
      passthrough.push(a);
    }
  }
  const override = env.MONEYSWITCH_SERVER_SPEC?.trim();
  const spec = override || `moneyswitch-server@${version}`;
  const npxArgs = ["-y", ...(registry ? [`--registry=${registry}`] : []), `--package=${spec}`, "--", "moneyswitch-server", "demo", ...passthrough];
  return { spec, registry, npxArgs, help };
}

/** npm's "package/version not found" signatures (E404 from the registry, ETARGET for a missing version). */
export function looksLikePackageNotFound(stderr: string): boolean {
  return /\bE404\b|404 Not Found|\bETARGET\b|No matching version found|is not in this registry|could not determine executable to run/i.test(stderr);
}

export function isOfficialRegistry(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).host === "registry.npmjs.org";
  } catch {
    return false;
  }
}

/** Locates npm's own npx-cli.js next to this Node (avoids spawning npx.cmd through a shell on Windows). */
function findNpmScript(name: "npx-cli.js" | "npm-cli.js"): string | null {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", name), // Windows installer layout
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", name), // unix prefix layout
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function quoteForCmd(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function runNpmTool(tool: "npx" | "npm", args: string[], stdio: "pipe-stderr" | "capture"): ChildProcess {
  const script = findNpmScript(tool === "npx" ? "npx-cli.js" : "npm-cli.js");
  const io = stdio === "capture" ? (["ignore", "pipe", "pipe"] as const) : (["inherit", "inherit", "pipe"] as const);
  if (script) return spawn(process.execPath, [script, ...args], { stdio: [...io] });
  const isWin = process.platform === "win32";
  return spawn(isWin ? `${tool}.cmd` : tool, isWin ? args.map(quoteForCmd) : args, { stdio: [...io], shell: isWin });
}

function effectiveRegistry(explicit: string | null): string | null {
  if (explicit) return explicit;
  if (process.env.npm_config_registry) return process.env.npm_config_registry;
  const script = findNpmScript("npm-cli.js");
  const r = script
    ? spawnSync(process.execPath, [script, "config", "get", "registry"], { encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["config", "get", "registry"], { encoding: "utf8", shell: process.platform === "win32" });
  const out = (r.stdout ?? "").trim();
  return out || null;
}

export async function runDemoLauncher(args: string[], version: string): Promise<number> {
  const inv = buildDemoInvocation(args, process.env, version);
  if (inv.help) {
    process.stdout.write(DEMO_HELP + "\n");
    return 0;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) {
    process.stderr.write(`moneyswitch demo: the demo server needs Node.js 22 or newer (this is ${process.version}).
`);
    return 1;
  }
  process.stderr.write(
    `moneyswitch demo: running ${inv.spec} (separate package, AGPL-3.0-only) via npx — first run downloads it…\n`
  );

  const child = runNpmTool("npx", inv.npxArgs, "pipe-stderr");
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
  });
  // Ctrl+C reaches the child too (same console / process group): let it clean
  // up its servers + temp dir, then exit with its code.
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", ignore);

  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`moneyswitch demo: could not start npx: ${err.message}\n`);
      resolve(1);
    });
    // 0xC000013A = STATUS_CONTROL_C_EXIT (Windows: npx ended by Ctrl+C / Ctrl+Break) → 130 like a SIGINT.
    child.on("exit", (c, signal) => resolve(c === 0xc000013a ? 130 : c ?? (signal ? 130 : 1)));
  });

  if (code !== 0 && looksLikePackageNotFound(stderrTail)) {
    const registry = effectiveRegistry(inv.registry);
    if (!isOfficialRegistry(registry)) {
      process.stderr.write(
        `\nmoneyswitch demo: ${inv.spec} was not found on your npm registry (${registry ?? "unknown"}).\n` +
          `A mirror may not have synced it yet — retry against the official registry:\n\n` +
          `  npx moneyswitch demo --registry=${OFFICIAL_REGISTRY}\n\n`
      );
    } else {
      process.stderr.write(
        `\nmoneyswitch demo: ${inv.spec} was not found on ${OFFICIAL_REGISTRY}.\n` +
          `To try a locally built package, set MONEYSWITCH_SERVER_SPEC to its .tgz path.\n\n`
      );
    }
  }
  return code;
}
