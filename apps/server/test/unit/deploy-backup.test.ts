// deploy/README.zh-CN.md's backup command and deploy/check-backup.sh.
//
// The data directory (/data in the container) is 0700 and its files 0600, owned by the server's `node` account. The old README
// told the operator to tar it as `--user root`, but the service runs with `cap_drop: ALL`: root without CAP_DAC_OVERRIDE /
// CAP_DAC_READ_SEARCH is just another account, so tar printed "Permission denied" and wrote an archive WITHOUT wallet.json and the
// unlock secret. check-backup.sh lists an archive and says so.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalWalletDriver } from "@moneyswitch/wallet";

const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false } as const;
const repoFile = (rel: string) => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
const README = fs.readFileSync(repoFile("deploy/README.zh-CN.md"), "utf8").replace(/\r\n/g, "\n");
const SCRIPT = fs.readFileSync(repoFile("deploy/check-backup.sh"), "utf8").replace(/\r\n/g, "\n"); // (a Windows checkout may have CRLF)

const hasShell = (() => {
  const probe = spawnSync("sh", ["-c", "command -v tar && command -v sed && command -v grep && command -v tr && command -v head"], { encoding: "utf8" });
  return probe.status === 0;
})();

describe("the documented backup command (deploy/README.zh-CN.md)", () => {
  const section = README.slice(README.indexOf("## 备份、升级和回滚"), README.indexOf("## 验收"));
  const commands = section.slice(section.indexOf("```sh"), section.indexOf("```", section.indexOf("```sh") + 5));

  it("does not tar the data directory as root: with cap_drop: ALL root cannot read a 0700 directory owned by node", () => {
    expect(section.length).toBeGreaterThan(200);
    expect(commands).not.toMatch(/--user\s+root/);
    expect(commands).toMatch(/--user\s+node\b[^\n]*--entrypoint tar\b/);
    expect(commands).toContain("-C /data -czf -");
    expect(section).toMatch(/cap_drop/);
  });

  it("checks the archive with deploy/check-backup.sh before the server is started again", () => {
    expect(commands).toContain("deploy/check-backup.sh");
    expect(commands.indexOf("check-backup.sh")).toBeGreaterThan(commands.indexOf("--entrypoint tar"));
    expect(commands.indexOf("check-backup.sh")).toBeLessThan(commands.indexOf("docker compose start server"));
  });

  it("offers the host-side alternative (what deploy/upgrade-us.sh does) and says what the check asserts", () => {
    expect(section).toContain("upgrade-us.sh");
    expect(section).toContain("wallet.json");
    expect(section).toMatch(/wallet-unlock-<地址>\.secret/);
  });
});

describe.skipIf(!hasShell)("deploy/check-backup.sh", () => {
  let work: string;
  let autoDir: string;
  let otherAutoDir: string;
  let passwordDir: string;
  let autoAddress: string;
  let otherAddress: string;
  let passwordAddress: string;

  const sh = (command: string) => spawnSync("sh", ["-c", command], { cwd: work, encoding: "utf8" });
  const check = (archive: string) => spawnSync("sh", ["check-backup.sh", archive], { cwd: work, encoding: "utf8" });
  const secretName = (address: string) => `wallet-unlock-${address.toLowerCase()}.secret`;
  /** tar of a directory into <work>/<name>; extra tar arguments go before the "." */
  const tarOf = (name: string, dir: string, extra = "") => {
    const r = sh(`tar -czf ${name} -C ${path.basename(dir)} ${extra} .`);
    expect(r.status, r.stderr).toBe(0);
    return name;
  };

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "ms-backup-check-"));
    fs.writeFileSync(path.join(work, "check-backup.sh"), SCRIPT);
    const make = async (name: string, password?: string) => {
      const dir = path.join(work, name);
      fs.mkdirSync(dir);
      const driver = new LocalWalletDriver(dir, FAST);
      const created = password ? await driver.createWallet(password) : await driver.createWithPhrase();
      fs.writeFileSync(path.join(dir, "moneyswitch.db"), "not a real database");
      fs.mkdirSync(path.join(dir, "retired"));
      fs.writeFileSync(path.join(dir, "retired", "wallet-old.json"), "{}");
      return { dir, address: created.address };
    };
    ({ dir: autoDir, address: autoAddress } = await make("data-auto"));
    ({ dir: otherAutoDir, address: otherAddress } = await make("data-other"));
    ({ dir: passwordDir, address: passwordAddress } = await make("data-password", "pw-for-the-test"));
  }, 60_000);

  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it("the data directory the test builds is what the driver really writes (guards the fixtures)", () => {
    expect(fs.existsSync(path.join(autoDir, "wallet.json"))).toBe(true);
    expect(fs.existsSync(path.join(autoDir, secretName(autoAddress)))).toBe(true);
    expect(fs.existsSync(path.join(passwordDir, "wallet.json"))).toBe(true);
    expect(fs.readdirSync(passwordDir).filter((f) => f.startsWith("wallet-unlock-"))).toEqual([]);
    expect(passwordAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("a complete backup of an auto-unlock wallet passes, and the answer names the wallet and its secret (never their contents)", () => {
    const r = check(tarOf("auto-ok.tgz", autoDir));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stdout).toContain(autoAddress.toLowerCase());
    expect(r.stdout).toContain(secretName(autoAddress));
    const secretText = fs.readFileSync(path.join(autoDir, secretName(autoAddress)), "utf8").trim();
    expect(r.stdout + r.stderr).not.toContain(secretText);
  });

  it("the stored names may or may not start with ./ (tar -C dir . versus tar <names>)", () => {
    const names = `wallet.json ${secretName(autoAddress)} moneyswitch.db`;
    const r1 = sh(`tar -czf plain-names.tgz -C ${path.basename(autoDir)} ${names}`);
    expect(r1.status, r1.stderr).toBe(0);
    const r = check("plain-names.tgz");
    expect(r.status, r.stderr).toBe(0);
  });

  it("FAILS when the unlock secret is missing: the restored wallet would stay locked", () => {
    const r = check(tarOf("no-secret.tgz", autoDir, "--exclude='./wallet-unlock-*'"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain(secretName(autoAddress));
    expect(r.stderr).toMatch(/locked/);
    expect(r.stderr).toContain("--user node");
    expect(r.stdout).not.toContain("OK");
  });

  it("FAILS when wallet.json is missing - the archive tar writes when it may read nothing but the directory", () => {
    const r = check(tarOf("no-wallet.tgz", autoDir, "--exclude='./wallet.json' --exclude='./wallet-unlock-*'"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("wallet.json");
    expect(r.stdout).not.toContain("OK");
  });

  it("FAILS for an archive of an empty directory", () => {
    fs.mkdirSync(path.join(work, "data-empty"), { recursive: true });
    const r = check(tarOf("empty-dir.tgz", path.join(work, "data-empty")));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("wallet.json");
  });

  it("FAILS when the secret that is in the archive belongs to ANOTHER wallet", () => {
    // wallet.json of A, but only B's secret next to it
    const mixed = path.join(work, "data-mixed");
    fs.mkdirSync(mixed, { recursive: true });
    fs.copyFileSync(path.join(autoDir, "wallet.json"), path.join(mixed, "wallet.json"));
    fs.copyFileSync(path.join(otherAutoDir, secretName(otherAddress)), path.join(mixed, secretName(otherAddress)));
    const r = check(tarOf("mixed.tgz", mixed));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(secretName(autoAddress));
  });

  it("a password-mode wallet needs no unlock secret in the archive", () => {
    const r = check(tarOf("password.tgz", passwordDir));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stdout).toContain("password");
    expect(r.stdout).toContain(passwordAddress.toLowerCase());
  });

  it("a wallet.json without the marker (written before the marker existed) is a password wallet too", () => {
    const legacy = path.join(work, "data-legacy");
    fs.mkdirSync(legacy, { recursive: true });
    const keystore = JSON.parse(fs.readFileSync(path.join(passwordDir, "wallet.json"), "utf8"));
    delete keystore["x-moneyswitch"];
    fs.writeFileSync(path.join(legacy, "wallet.json"), JSON.stringify(keystore));
    const r = check(tarOf("legacy.tgz", legacy));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("password");
  });

  it("reads a pretty-printed wallet.json with CRLF line ends and a checksummed (mixed-case) address just as well", () => {
    const pretty = path.join(work, "data-pretty");
    fs.mkdirSync(pretty, { recursive: true });
    const keystore = JSON.parse(fs.readFileSync(path.join(autoDir, "wallet.json"), "utf8"));
    expect(keystore["x-moneyswitch"]).toEqual({ version: 1, protection: "auto" });
    keystore.address = autoAddress.slice(2); // checksummed, no 0x
    fs.writeFileSync(path.join(pretty, "wallet.json"), JSON.stringify(keystore, null, 2).replace(/\n/g, "\r\n"));
    // without the secret it must still FAIL (so the marker was found), with it it passes
    const without = check(tarOf("pretty-no-secret.tgz", pretty));
    expect(without.status).toBe(1);
    expect(without.stderr).toContain(secretName(autoAddress));
    fs.copyFileSync(path.join(autoDir, secretName(autoAddress)), path.join(pretty, secretName(autoAddress)));
    const withSecret = check(tarOf("pretty.tgz", pretty));
    expect(withSecret.status, withSecret.stderr).toBe(0);
  });

  it("FAILS for a file that is not a tar.gz, an empty file, and a file that does not exist; wrong usage is 2", () => {
    fs.writeFileSync(path.join(work, "not-an-archive.tgz"), "hello");
    fs.writeFileSync(path.join(work, "zero.tgz"), "");
    expect(check("not-an-archive.tgz").status).toBe(1);
    expect(check("zero.tgz").status).toBe(1);
    expect(check("does-not-exist.tgz").status).toBe(1);
    const usage = spawnSync("sh", ["check-backup.sh"], { cwd: work, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage");
  });
});
