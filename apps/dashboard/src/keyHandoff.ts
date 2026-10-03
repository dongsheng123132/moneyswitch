// What the Money Keys page hands to the operator right after a secret exists:
// a freshly created key, or the new secret of "Reset secret and copy skill".
// Plain data + one small async helper, so the state transition is testable
// without a DOM (see test/keyHandoff.test.ts).
import type { CreateMoneyKeyResponse, RotateKeyResponse } from "./api";

export interface Handoff {
  /** Unique per handoff; use it as the React key so a new secret starts a fresh view (never use the secret itself as a key). */
  id: number;
  kind: "created" | "rotated";
  /** The plaintext MoneyKey. Shown once; only ever held in React state. */
  key: string;
  name: string;
  /** The hosts the key may pay: whether the install prompt may ask for the test payment depends on them. */
  allowedHosts: string[];
}

let nextId = 1;

export function handoffFromCreated(res: Pick<CreateMoneyKeyResponse, "key" | "name" | "allowed_hosts">): Handoff {
  return { id: nextId++, kind: "created", key: res.key, name: res.name, allowedHosts: res.allowed_hosts ?? [] };
}

export function handoffFromRotated(res: Pick<RotateKeyResponse, "key" | "name" | "allowed_hosts">): Handoff {
  return { id: nextId++, kind: "rotated", key: res.key, name: res.name, allowedHosts: res.allowed_hosts ?? [] };
}

export type RotateOutcome = { ok: true; handoff: Handoff } | { ok: false; message: string };

/**
 * Resets the secret of key `id` and returns what the page must show next: the
 * NEW secret as the one and only handoff (never the key that was shown when the
 * key was created, whose secret is dead now). On failure nothing is handed over.
 */
export async function rotateToHandoff(id: string, rotate: (id: string) => Promise<RotateKeyResponse>): Promise<RotateOutcome> {
  try {
    return { ok: true, handoff: handoffFromRotated(await rotate(id)) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "rotate_failed" };
  }
}
