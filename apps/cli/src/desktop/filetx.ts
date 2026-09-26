import fs from "node:fs";
import path from "node:path";

/**
 * SPEC-v0.4 §B 安全: every write is  backup -> write -> verify (read back and
 * parse) -> on failure restore every backup taken in this transaction.
 *
 * Backups are `<file>.bak-<epoch ms>` next to the original (same convention as
 * `moneyswitch connect`), taken only for files that already exist. A file that
 * did not exist before is deleted again on rollback.
 */
export class FileTransaction {
  private readonly touched = new Map<string, { backup: string | null; existed: boolean }>();
  readonly backups: string[] = [];
  private readonly stamp: number;

  constructor(stamp: number = Date.now()) {
    this.stamp = stamp;
  }

  /** Take a backup of `file` (once per transaction). Call before anything modifies it, including agent CLIs. */
  snapshot(file: string): string | null {
    const known = this.touched.get(file);
    if (known) return known.backup;
    const existed = fs.existsSync(file);
    let backup: string | null = null;
    if (existed) {
      backup = `${file}.bak-${this.stamp}`;
      let n = 1;
      while (fs.existsSync(backup)) backup = `${file}.bak-${this.stamp}-${n++}`;
      fs.copyFileSync(file, backup);
      this.backups.push(backup);
    }
    this.touched.set(file, { backup, existed });
    return backup;
  }

  /** Write `content` to `file` (snapshotting first), then re-read and run `verify` on what is actually on disk. */
  write(file: string, content: string, verify?: (onDisk: string) => void): void {
    this.snapshot(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    const back = fs.readFileSync(file, "utf8");
    if (back !== content) throw new Error(`read-back mismatch for ${file}`);
    verify?.(back);
  }

  /** Delete `file` (snapshotting first). */
  remove(file: string): void {
    this.snapshot(file);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  /** Restore every touched file to its pre-transaction state. Never throws; returns what failed. */
  rollback(): string[] {
    const errors: string[] = [];
    for (const [file, { backup, existed }] of this.touched) {
      try {
        if (existed && backup) fs.copyFileSync(backup, file);
        else if (!existed && fs.existsSync(file)) fs.rmSync(file);
      } catch (e) {
        errors.push(`${file}: ${(e as Error).message}`);
      }
    }
    return errors;
  }
}

export function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
