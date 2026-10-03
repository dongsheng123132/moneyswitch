import { AdminResetError, resetAdminTokenInFile } from "@moneyswitch/server/start";
import { resolveDataPaths } from "./paths.js";

export interface ResetDeps {
  env?: NodeJS.ProcessEnv;
  /** Replaces the administrator token in the database file and returns the new one (tests inject a fake). */
  reset?: (dbFilePath: string) => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/**
 * `moneyswitch-server reset-admin-token`: replaces the administrator token of the database the service uses (same data directory
 * resolution as the server) and prints the new token ONCE, on stdout and nowhere else: not in the server's log, not on stderr.
 * Everything a person needs to read (what happened, why it was refused) goes to stderr, so `TOKEN=$(… reset-admin-token)` captures
 * the bare token. Returns the exit code: 0 done, 1 refused or failed (nothing was changed, nothing is printed on stdout).
 */
export function runResetAdminToken(dataDirFlag: string | null, deps: ResetDeps = {}): number {
  const env = deps.env ?? process.env;
  const reset = deps.reset ?? resetAdminTokenInFile;
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(text));

  const { dbFilePath } = resolveDataPaths(dataDirFlag, env);
  let token: string;
  try {
    token = reset(dbFilePath);
  } catch (e) {
    err(`moneyswitch-server: ${e instanceof AdminResetError ? e.message : `could not reset the administrator token: ${e instanceof Error ? e.message : String(e)}`}\n`);
    return 1;
  }
  err("New administrator token below. It is shown only now. The old one has stopped working; the running server needs no restart.\n");
  out(`${token}\n`);
  return 0;
}
