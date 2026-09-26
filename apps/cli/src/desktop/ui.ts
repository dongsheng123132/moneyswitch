import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealCommandRunner } from "moneyswitch-connect/lib/runner";
import { createUiServer } from "./server.js";
import { DesktopService } from "./service.js";
import { SessionManager } from "./session.js";

export const UI_HELP = `moneyswitch ui - local desktop console (SPEC-v0.4 §B)

Usage:
  moneyswitch ui [--port 4318] [--no-open]

Starts a web console on http://127.0.0.1:<port> (loopback only) and opens it
with a one-time login link. Configure Claude Code / Codex: model key ("brain")
+ MoneyKey ("wallet"), preview the exact config diff, then enable.

Environment: MONEYSWITCH_UI_PORT, MONEYSWITCH_UI_NO_OPEN=1.
All paths follow HOME/USERPROFILE, CLAUDE_CONFIG_DIR and CODEX_HOME.`;

export interface UiArgs {
  port: number;
  open: boolean;
  help: boolean;
}

export function parseUiArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): UiArgs | { error: string } {
  let port = env.MONEYSWITCH_UI_PORT ? Number(env.MONEYSWITCH_UI_PORT) : 4318;
  let open = env.MONEYSWITCH_UI_NO_OPEN !== "1";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice(7));
    } else if (a === "--no-open") {
      open = false;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "--port must be 1-65535" };
  return { port, open, help };
}

function openBrowser(url: string) {
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", '""', `"${url}"`], { ...opts, windowsVerbatimArguments: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], opts);
  child.on("error", () => undefined);
  child.unref();
}

export async function runUi(argv: string[]): Promise<number> {
  const parsed = parseUiArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`moneyswitch ui: ${parsed.error}\n\n${UI_HELP}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(UI_HELP + "\n");
    return 0;
  }
  const env = process.env;
  const service = new DesktopService({ env, runner: new RealCommandRunner({ env, timeoutMs: 60_000 }) });
  const sessions = new SessionManager(parsed.port);
  const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
  const { server } = createUiServer({
    port: parsed.port,
    service,
    assetsDir,
    sessions,
    log: env.MONEYSWITCH_UI_DEBUG ? (l) => process.stderr.write(`[ui] ${l}\n`) : undefined,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsed.port, "127.0.0.1", () => resolve());
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`moneyswitch ui: port ${parsed.port} is already in use (another console running?). Try --port ${parsed.port + 1}.\n`);
    } else {
      process.stderr.write(`moneyswitch ui: ${e.message}\n`);
    }
    process.exit(1);
  });

  const url = `http://127.0.0.1:${parsed.port}/#${sessions.pendingToken}`;
  process.stdout.write(
    `MoneySwitch desktop console: http://127.0.0.1:${parsed.port}\n` +
      `One-time login link (do not share): ${url}\n` +
      `Press Ctrl+C to stop.\n`
  );
  if (parsed.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
