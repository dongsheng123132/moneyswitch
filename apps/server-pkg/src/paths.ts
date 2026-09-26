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
