import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Polls a URL until it responds with any HTTP status < 500 (i.e. the process is up and listening). */
export async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Spawns a child process, piping its stdout+stderr to a log file in APPEND
 * mode (never truncated) so callers can point people at "which file has the
 * admin token" without ever needing to grep secrets into a shared terminal —
 * and, critically, so a restart never destroys a still-relevant admin token
 * that was only ever printed once on first boot of a data directory. Each
 * run writes a `===== <ISO timestamp> start =====` separator line first, so
 * old and new runs stay visually distinguishable in the same file.
 */
export function spawnLogged(name, command, args, opts, logFilePath) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  logStream.write(`\n===== ${new Date().toISOString()} start =====\n`);
  const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("exit", (code, signal) => {
    logStream.write(`\n[${name}] exited (code=${code} signal=${signal})\n`);
  });
  return child;
}

/** Registers SIGINT/SIGTERM handlers that kill every given child process once, then exit. */
export function installShutdownHandlers(children) {
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[demo] received ${signal}, stopping all child processes...`);
    for (const child of children) {
      if (child && !child.killed) child.kill();
    }
    // Give children a moment to exit cleanly before the parent exits.
    setTimeout(() => process.exit(0), 500);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
