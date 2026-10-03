import { generateSetupToken, sha256Hex, verifySecretAgainstHash } from "./moneykey.js";

/**
 * First-run setup link (docs/ux-audit.md "威胁分析" §1).
 *
 * On the very first boot of a data directory the server already prints the
 * freshly generated admin token to stdout exactly once. This store adds a
 * one-time *setup token* printed next to it as a clickable
 * `/login#ms_setup_…` link, so a human can open the Dashboard already logged
 * in instead of copy-pasting the admin token out of a log file.
 *
 * Security properties (all enforced here, unit-tested in test/setup.test.ts):
 * - memory only: only the SHA-256 of the setup token is kept, plus the admin
 *   token it will hand over; nothing is persisted, so a restart voids it;
 * - single use: the first successful claim returns the admin token and wipes
 *   both values from memory;
 * - expires after `ttlMs`;
 * - burns itself after `maxFailedAttempts` wrong guesses;
 * - constant-time comparison (verifySecretAgainstHash).
 *
 * There is deliberately NO "trust loopback" shortcut: agents run on the same
 * machine and call 127.0.0.1 too, so the only proof of being the operator is
 * possession of a secret that was printed to the server's own stdout — the
 * same channel the admin token itself already goes to.
 */
export type SetupClaimResult =
  | { ok: true; adminToken: string }
  | { ok: false; reason: "SETUP_INVALID" | "SETUP_USED" | "SETUP_EXPIRED" | "SETUP_INACTIVE" };

export interface SetupTokenStoreOptions {
  ttlMs?: number;
  maxFailedAttempts?: number;
  now?: () => number;
}

export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;
export const SETUP_TOKEN_MAX_FAILED_ATTEMPTS = 10;

export class SetupTokenStore {
  private tokenHash: string | null = null;
  private adminToken: string | null = null;
  private expiresAt = 0;
  private failedAttempts = 0;
  private state: "inactive" | "active" | "used" | "burned" = "inactive";
  private readonly ttlMs: number;
  private readonly maxFailedAttempts: number;
  private readonly now: () => number;

  constructor(opts: SetupTokenStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? SETUP_TOKEN_TTL_MS;
    this.maxFailedAttempts = opts.maxFailedAttempts ?? SETUP_TOKEN_MAX_FAILED_ATTEMPTS;
    this.now = opts.now ?? Date.now;
  }

  /** Issues a new one-time setup token bound to `adminToken`; returns the plaintext setup token (print it once, never log it again). */
  issue(adminToken: string): string {
    const token = generateSetupToken();
    this.tokenHash = sha256Hex(token);
    this.adminToken = adminToken;
    this.expiresAt = this.now() + this.ttlMs;
    this.failedAttempts = 0;
    this.state = "active";
    return token;
  }

  /** True while an unused, unexpired, un-burned setup token exists. */
  isActive(): boolean {
    if (this.state !== "active") return false;
    if (this.now() > this.expiresAt) {
      this.wipe("burned");
      return false;
    }
    return true;
  }

  claim(candidate: unknown): SetupClaimResult {
    if (this.state === "used") return { ok: false, reason: "SETUP_USED" };
    if (this.state !== "active" || !this.tokenHash || !this.adminToken) return { ok: false, reason: "SETUP_INACTIVE" };
    if (this.now() > this.expiresAt) {
      this.wipe("burned");
      return { ok: false, reason: "SETUP_EXPIRED" };
    }
    if (typeof candidate !== "string" || !verifySecretAgainstHash(candidate, this.tokenHash)) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= this.maxFailedAttempts) this.wipe("burned");
      return { ok: false, reason: "SETUP_INVALID" };
    }
    const adminToken = this.adminToken;
    this.wipe("used");
    return { ok: true, adminToken };
  }

  private wipe(next: "used" | "burned") {
    this.tokenHash = null;
    this.adminToken = null;
    this.state = next;
  }
}
