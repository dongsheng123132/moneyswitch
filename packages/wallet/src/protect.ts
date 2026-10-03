import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * OS-level protection of the data directory and the auto-unlock secret.
 *
 * With auto-unlock the secret that opens wallet.json sits in the same directory, so WHO CAN READ THAT
 * DIRECTORY decides who can spend the wallet. File modes are not enough on Windows (0o600 means nothing
 * there: a file simply inherits the directory's ACL, which on a normal machine lets other local accounts and
 * sandboxed agents read it), so:
 *
 *  - Windows: a protected DACL (inheritance removed) with exactly two allow entries, the current user and
 *    SYSTEM, set with PowerShell on the directory and on the secret file, then read back and verified. Trustees
 *    are SIDs (the user SID, S-1-5-18), never localized account names.
 *  - POSIX: the directory 0700 and the secret 0600, verified.
 *
 * Nothing here refuses to run: when the protection cannot be applied or verified the caller keeps working and
 * reports `ok: false` (health.secret_protected = false) so the operator sees a red warning.
 */
export interface SecretProtection {
  ok: boolean;
  method: "acl" | "posix";
  /** Why it failed (never contains a secret), or a short note. */
  detail?: string;
}

export interface ProtectTargets {
  /** The data directory. */
  dir: string;
  /** The auto-unlock secret file, once it exists. */
  file?: string;
}

export type Protector = (targets: ProtectTargets) => SecretProtection;

export interface ProtectOptions {
  /** Test seam: the PowerShell executable to use on Windows. */
  powershellPath?: string;
}

const SYSTEM_SID = "S-1-5-18";

export function defaultProtector(options: ProtectOptions = {}): Protector {
  return process.platform === "win32" ? (targets) => protectWindows(targets, options) : protectPosix;
}

// ---------------------------------------------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------------------------------------------

function protectPosix({ dir, file }: ProtectTargets): SecretProtection {
  const problems: string[] = [];
  const tighten = (target: string, mode: number, label: string) => {
    try {
      fs.chmodSync(target, mode);
      if ((fs.statSync(target).mode & 0o077) !== 0) problems.push(`${label} is still accessible to other users`);
    } catch (e) {
      problems.push(`${label}: ${(e as NodeJS.ErrnoException).code ?? "cannot change mode"}`);
    }
  };
  tighten(dir, 0o700, "data directory");
  if (file) tighten(file, 0o600, "unlock secret");
  return problems.length ? { ok: false, method: "posix", detail: problems.join("; ") } : { ok: true, method: "posix" };
}

// ---------------------------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------------------------

// The paths arrive in an environment variable (never spliced into the script), so spaces, quotes and
// non-ASCII characters in the data directory cannot break out of it.
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sys = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
Write-Output ('ME|' + $me.Value)
$index = 0
foreach ($p in ($env:MS_ACL_PATHS -split '\|')) {
  if (-not $p) { continue }
  $item = Get-Item -LiteralPath $p -Force
  # A brand-new security object replaces the whole DACL (every explicit entry and, being protected, every inherited one).
  # It carries no owner and no audit section, so only the DACL is written: Set-Acl on a Get-Acl object would also try to
  # write the SACL and fail with "SeSecurityPrivilege not held" when applied a second time.
  if ($item.PSIsContainer) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($id in @($me, $sys)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($id, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  $item.SetAccessControl($acl)
  $now = Get-Acl -LiteralPath $p
  Write-Output ('SDDL|' + $index + '|' + $now.GetSecurityDescriptorSddlForm('Access'))
  $index++
}
`;

function shortError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
  const text = (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf-8") ?? "").trim().split(/\r?\n/)[0];
  return (text || err.code || err.message || "unknown error").slice(0, 200);
}

/** Does this SDDL describe a protected DACL whose only entries are full-control allows for `allowed` SIDs? */
export function evaluateSddl(sddl: string, allowed: string[]): { ok: boolean; why?: string } {
  const match = /^D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl.trim());
  if (!match) return { ok: false, why: "unreadable ACL" };
  if (!match[1].includes("P")) return { ok: false, why: "inheritance is not blocked" };
  const aces = [...match[2].matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
  if (aces.length === 0) return { ok: false, why: "the ACL is empty" };
  const trustees = new Set<string>();
  for (const ace of aces) {
    if (ace[0] !== "A") return { ok: false, why: "unexpected non-allow entry" };
    trustees.add(ace[5] === "SY" ? SYSTEM_SID : ace[5]);
  }
  const want = new Set(allowed);
  const extra = [...trustees].filter((t) => !want.has(t));
  const missing = [...want].filter((t) => !trustees.has(t));
  if (extra.length) return { ok: false, why: `other accounts still have access (${extra.join(", ")})` };
  if (missing.length) return { ok: false, why: `${missing.join(", ")} lost access` };
  return { ok: true };
}

function protectWindows({ dir, file }: ProtectTargets, options: ProtectOptions): SecretProtection {
  const exe = options.powershellPath ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const targets = [dir, ...(file ? [file] : [])];
  let output: string;
  try {
    output = execFileSync(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64")],
      { env: { ...process.env, MS_ACL_PATHS: targets.join("|") }, encoding: "utf-8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    return { ok: false, method: "acl", detail: `could not set the ACL (PowerShell): ${shortError(e)}` };
  }
  const lines = output.split(/\r?\n/).filter(Boolean);
  const me = lines.find((l) => l.startsWith("ME|"))?.slice(3).trim();
  if (!me) return { ok: false, method: "acl", detail: "could not determine the current user" };
  const problems: string[] = [];
  // (results are matched by position, not by echoing the path: console encodings mangle non-ASCII paths)
  targets.forEach((target, i) => {
    const line = lines.find((l) => l.startsWith(`SDDL|${i}|`));
    if (!line) {
      problems.push(`${path.basename(target)}: ACL could not be read back`);
      return;
    }
    const verdict = evaluateSddl(line.slice(`SDDL|${i}|`.length), [me, SYSTEM_SID]);
    if (!verdict.ok) problems.push(`${path.basename(target)}: ${verdict.why}`);
  });
  return problems.length ? { ok: false, method: "acl", detail: problems.join("; ") } : { ok: true, method: "acl" };
}
