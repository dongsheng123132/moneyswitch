import React from "react";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";
import type { ApprovalPinState } from "../api";
import { PIN_MAX_FAILURES } from "../approvalPin";
import "../styles/keys.css";

/**
 * The approval PIN of a root key in the key list (SPEC.md §3): nothing while it is usable; a note when only the administrator can approve for the
 * key (no PIN: a key issued before v0.7.4) or when the PIN is locked after five wrong tries; a usable PIN that has had wrong tries says how many
 * (they are cumulative since the PIN was set: five lock it). A child key (null) uses its root key's PIN: no note.
 */
export default function KeyPinState({ state, failures }: { state: ApprovalPinState | null | undefined; failures?: number | null }) {
  const t = useT(keysStrings);
  if (state === "none") {
    return (
      <div className="key-pin-state warn" data-testid="key-pin-none">
        {t("pinNone")}
      </div>
    );
  }
  if (state === "locked") {
    return (
      <div className="key-pin-state warn" data-testid="key-pin-locked">
        {t("pinLocked")}
      </div>
    );
  }
  if (state === "set" && failures != null && failures > 0) {
    return (
      <div className="key-pin-state warn" data-testid="key-pin-failures">
        {t("pinFailures", { n: failures, max: PIN_MAX_FAILURES })}
      </div>
    );
  }
  return null;
}
