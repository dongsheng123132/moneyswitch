import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { AdminResetError } from "@moneyswitch/server/start";
import { resolveDataPaths } from "../../src/paths.js";
import { runResetAdminToken } from "../../src/reset.js";

const TOKEN = "ms_admin_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

function run(dataDirFlag: string | null, env: NodeJS.ProcessEnv, reset: (dbFilePath: string) => string) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runResetAdminToken(dataDirFlag, {
    env,
    reset: (dbFilePath) => {
      calls.push(dbFilePath);
      return reset(dbFilePath);
    },
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
  });
  return { code, calls, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("which database the reset works on: the one the service uses", () => {
  it("--data-dir wins, then MONEYSWITCH_DATA_DIR (the Docker image sets /data), then ~/.moneyswitch/server; the file is moneyswitch.sqlite", () => {
    expect(resolveDataPaths("/srv/ms", { MONEYSWITCH_DATA_DIR: "/data" }).dbFilePath).toBe(path.join(path.resolve("/srv/ms"), "moneyswitch.sqlite"));
    expect(resolveDataPaths(null, { MONEYSWITCH_DATA_DIR: "/data" })).toEqual({
      dataDir: path.resolve("/data"),
      dbFilePath: path.join(path.resolve("/data"), "moneyswitch.sqlite"),
    });
    expect(resolveDataPaths(null, {}).dataDir).toBe(path.join(os.homedir(), ".moneyswitch", "server"));
  });

  it("MONEYSWITCH_DB_PATH moves the database exactly as it does for the server", () => {
    expect(resolveDataPaths("/srv/ms", { MONEYSWITCH_DB_PATH: "/elsewhere/ms.db" }).dbFilePath).toBe("/elsewhere/ms.db");
  });

  it("an empty or blank MONEYSWITCH_DATA_DIR counts as unset, as in apps/server (it used to mean the current directory)", () => {
    const home = path.join(os.homedir(), ".moneyswitch", "server");
    expect(resolveDataPaths(null, { MONEYSWITCH_DATA_DIR: "" }).dataDir).toBe(home);
    expect(resolveDataPaths(null, { MONEYSWITCH_DATA_DIR: "   " }).dataDir).toBe(home);
    expect(resolveDataPaths(null, { MONEYSWITCH_DATA_DIR: "" }).dataDir).not.toBe(path.resolve(""));
  });
});

describe("moneyswitch-server reset-admin-token (the command, with the reset itself replaced)", () => {
  it("prints the new token once on stdout, bare, and the explanation on stderr; exit code 0", () => {
    const r = run("/srv/ms", {}, () => TOKEN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${TOKEN}\n`);
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toMatch(/shown only now/);
    expect(r.calls).toEqual([path.join(path.resolve("/srv/ms"), "moneyswitch.sqlite")]);
  });

  it("names the database it changed (on stderr), so a reset of the wrong instance is obvious", () => {
    const r = run("/srv/ms", {}, () => TOKEN);
    expect(r.stderr).toContain(`Administrator token replaced in ${path.join(path.resolve("/srv/ms"), "moneyswitch.sqlite")}`);
    expect(r.stdout).toBe(`${TOKEN}\n`);
  });

  it("uses the configured data directory when no flag is given", () => {
    const r = run(null, { MONEYSWITCH_DATA_DIR: "/data" }, () => TOKEN);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([path.join(path.resolve("/data"), "moneyswitch.sqlite")]);
  });

  it("a refusal prints the reason on stderr, nothing on stdout, and exits 1", () => {
    const r = run("/srv/ms", {}, () => {
      throw new AdminResetError("NO_DATABASE", "No MoneySwitch database found at /srv/ms/moneyswitch.sqlite. Nothing was changed.");
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("moneyswitch-server: No MoneySwitch database found at /srv/ms/moneyswitch.sqlite. Nothing was changed.\n");
  });

  it("any other failure also exits 1 with a message and nothing on stdout", () => {
    const r = run("/srv/ms", {}, () => {
      throw new Error("disk I/O error");
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/could not reset the administrator token: disk I\/O error/);
  });
});
