import { execFile } from "node:child_process";
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
 *    are SIDs (the user SID, S-1-5-18), never localized account names, and the read-back is by SID too:
 *    SDDL writes the well-known accounts as aliases (SY, LS, NS, LA, BA, ...), which cannot be mapped back
 *    reliably (LA is the built-in Administrator, whose SID depends on the machine).
 *  - POSIX: the directory 0700 and the secret 0600, verified.
 *
 * Nothing here refuses to run: when the protection cannot be applied or verified the caller keeps working and
 * reports `ok: false` (health.secret_protected = false) so the operator sees a red warning. And nothing here
 * blocks the event loop: PowerShell takes 1-3 s, so it runs as a child process the server keeps serving around.
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

/** Applies and verifies the protection. May be synchronous (tests inject plain functions); the real ones are asynchronous. */
export type Protector = (targets: ProtectTargets) => SecretProtection | Promise<SecretProtection>;

export interface ProtectOptions {
  /** Test seam: the PowerShell executable to use on Windows. */
  powershellPath?: string;
  /** How long PowerShell may take before it is given up on and the protection reported as not verified (default 30 s). */
  timeoutMs?: number;
  /** Test seam: a script to run instead of the real one (for example one that never answers). */
  script?: string;
}

const SYSTEM_SID = "S-1-5-18";
const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultProtector(options: ProtectOptions = {}): Protector {
  return process.platform === "win32" ? (targets) => protectWindows(targets, options) : async (targets) => protectPosix(targets);
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
//
// What it prints (one line each, SIDs only):  ME|<sid of the current user>
//                                              PROT|<index>|<True if inheritance is blocked>
//                                              ACE|<index>|<Allow/Deny>|<sid>|<rights as a number>|<True if inherited>
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sys = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
Write-Output ('ME|' + $me.Value)
$index = 0
foreach ($p in ($env:MS_ACL_PATHS -split '\|')) {
  if (-not $p) { continue }
  # Plain .NET only, no cmdlets from auto-loaded modules (Get-Item, Get-Acl): a server started from PowerShell 7 passes on
  # PS7's PSModulePath, and Windows PowerShell 5.1 then loads the wrong Microsoft.PowerShell.Security and those cmdlets fail.
  if ([System.IO.Directory]::Exists($p)) { $item = New-Object System.IO.DirectoryInfo($p) } else { $item = New-Object System.IO.FileInfo($p) }
  # A brand-new security object replaces the whole DACL (every explicit entry and, being protected, every inherited one).
  # It carries no owner and no audit section, so only the DACL is written: Set-Acl on a Get-Acl object would also try to
  # write the SACL and fail with "SeSecurityPrivilege not held" when applied a second time.
  if ($item -is [System.IO.DirectoryInfo]) {
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
  # Read it back from the system, as SIDs.
  $item.Refresh()
  $now = $item.GetAccessControl()
  Write-Output ('PROT|' + $index + '|' + $now.AreAccessRulesProtected)
  foreach ($r in $now.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    Write-Output ('ACE|' + $index + '|' + $r.AccessControlType + '|' + $r.IdentityReference.Value + '|' + [int]$r.FileSystemRights + '|' + $r.IsInherited)
  }
  $index++
}
`;

export interface AclEntry {
  /** "Allow" or "Deny". */
  type: string;
  /** The trustee as a SID string. */
  sid: string;
  /** FileSystemRights as a number. */
  rights: number;
  inherited: boolean;
}

export interface AclReadback {
  /** True when inheritance from the parent is blocked. */
  protected: boolean;
  entries: AclEntry[];
}

/** Parses what the PowerShell script printed: the current user's SID and, per target (by position), its read-back ACL. */
export function parseAclOutput(output: string): { me: string | null; readbacks: Map<number, AclReadback> } {
  let me: string | null = null;
  const readbacks = new Map<number, AclReadback>();
  const at = (index: number): AclReadback => {
    let r = readbacks.get(index);
    if (!r) readbacks.set(index, (r = { protected: false, entries: [] }));
    return r;
  };
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts[0] === "ME" && parts[1]) me = parts[1].trim();
    else if (parts[0] === "PROT" && parts.length >= 3) at(Number(parts[1])).protected = parts[2].trim().toLowerCase() === "true";
    else if (parts[0] === "ACE" && parts.length >= 6) {
      at(Number(parts[1])).entries.push({ type: parts[2], sid: parts[3], rights: Number(parts[4]), inherited: parts[5].trim().toLowerCase() === "true" });
    }
  }
  return { me, readbacks };
}

/** Does this read-back describe a protected ACL whose only entries are allows for exactly `allowedSids`? */
export function evaluateAcl(readback: AclReadback | undefined, allowedSids: string[]): { ok: boolean; why?: string } {
  if (!readback) return { ok: false, why: "ACL could not be read back" };
  if (!readback.protected) return { ok: false, why: "inheritance is not blocked" };
  if (readback.entries.length === 0) return { ok: false, why: "the ACL is empty" };
  const trustees = new Set<string>();
  for (const entry of readback.entries) {
    if (entry.type !== "Allow") return { ok: false, why: "unexpected non-allow entry" };
    if (entry.inherited) return { ok: false, why: "unexpected inherited entry" };
    trustees.add(entry.sid);
  }
  const want = new Set(allowedSids);
  const extra = [...trustees].filter((t) => !want.has(t));
  const missing = [...want].filter((t) => !trustees.has(t));
  if (extra.length) return { ok: false, why: `other accounts still have access (${extra.join(", ")})` };
  if (missing.length) return { ok: false, why: `${missing.join(", ")} lost access` };
  return { ok: true };
}

function shortError(e: unknown, timeoutMs: number): string {
  const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string; killed?: boolean };
  if (err.killed) return `PowerShell did not answer within ${Math.round(timeoutMs / 1000) || 1} s`;
  const text = readableStderr(typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf-8") ?? "");
  return (text || err.code || err.message || "unknown error").slice(0, 200);
}

/** PowerShell writes errors as CLIXML ("#< CLIXML" + XML) when its streams are redirected: turn the error records into plain text. */
export function readableStderr(stderr: string): string {
  const text = stderr.trim();
  if (!text.startsWith("#< CLIXML")) return text.split(/\r?\n/)[0] ?? "";
  const errors = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) =>
      m[1]
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return errors || "PowerShell reported an error";
}

/**
 * The environment for powershell.exe (Windows PowerShell 5.1): ours without PSModulePath. A server started from PowerShell 7
 * inherits PS7's module path; 5.1 then loads PS7's modules and its cmdlets fail. Without the variable, 5.1 uses its own
 * default. Windows environment names are case-insensitive, so every spelling is dropped.
 */
export function powerShellEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "psmodulepath") env[k] = v;
  return { ...env, ...extra };
}

/** Runs PowerShell as a child process the event loop keeps serving around (never execFileSync: it would stop the whole server). */
function runPowerShell(exe: string, script: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env, encoding: "utf-8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          reject(error);
        } else resolve(stdout);
      }
    );
    child.stdin?.end(); // nothing to read: PowerShell must never wait for input
  });
}

async function protectWindows({ dir, file }: ProtectTargets, options: ProtectOptions): Promise<SecretProtection> {
  const exe = options.powershellPath ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targets = [dir, ...(file ? [file] : [])];
  let output: string;
  try {
    output = await runPowerShell(exe, options.script ?? POWERSHELL_SCRIPT, powerShellEnv({ MS_ACL_PATHS: targets.join("|") }), timeoutMs);
  } catch (e) {
    return { ok: false, method: "acl", detail: `could not set the ACL (PowerShell): ${shortError(e, timeoutMs)}` };
  }
  const { me, readbacks } = parseAclOutput(output);
  if (!me) return { ok: false, method: "acl", detail: "could not determine the current user" };
  const problems: string[] = [];
  // (results are matched by position, not by echoing the path: console encodings mangle non-ASCII paths)
  targets.forEach((target, i) => {
    const verdict = evaluateAcl(readbacks.get(i), [me, SYSTEM_SID]);
    if (!verdict.ok) problems.push(`${path.basename(target)}: ${verdict.why}`);
  });
  return problems.length ? { ok: false, method: "acl", detail: problems.join("; ") } : { ok: true, method: "acl" };
}
