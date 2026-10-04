import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed package (the bundle lives in <root>/dist/cli.js). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function bundledDashboardDir(): string {
  return path.join(packageRoot(), "dashboard");
}

export function bundledMigrationsDir(): string {
  return path.join(packageRoot(), "migrations");
}

/**
 * Where the data lives: --data-dir, else $MONEYSWITCH_DATA_DIR (the Docker image sets /data), else ~/.moneyswitch/server; the
 * database is <dir>/moneyswitch.sqlite unless $MONEYSWITCH_DB_PATH says otherwise. One function for the server and for
 * `reset-admin-token`, so the reset always finds the database the service is using.
 */
export function resolveDataPaths(dataDirFlag: string | null, env: NodeJS.ProcessEnv = process.env): { dataDir: string; dbFilePath: string } {
  // An empty or blank MONEYSWITCH_DATA_DIR counts as unset (as in apps/server); before, "" resolved to the current directory.
  const fromEnv = env.MONEYSWITCH_DATA_DIR?.trim() ? env.MONEYSWITCH_DATA_DIR : undefined;
  const dataDir = path.resolve(dataDirFlag ?? fromEnv ?? path.join(os.homedir(), ".moneyswitch", "server"));
  return { dataDir, dbFilePath: env.MONEYSWITCH_DB_PATH || path.join(dataDir, "moneyswitch.sqlite") };
}
