import React from "react";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";
import CopyButton from "./CopyButton";

/**
 * The approval PIN, shown once (SPEC.md §3): when a key is issued, and when the administrator sets one. It is for a PERSON, so it sits apart
 * from the key and the skill text and says so: the AI never gets it, and the AI's link needs it. Only ever held in React state.
 */
export default function ApprovalPinNotice({ pin }: { pin: string }) {
  const t = useT(keysStrings);
  return (
    <div className="approval-pin-box" data-testid="approval-pin-handoff">
      <div className="approval-pin-title">{t("pinHandoffTitle")}</div>
      <div className="key-big approval-pin-big" data-testid="approval-pin-value">
        {pin}
      </div>
      <CopyButton text={pin} />
      <div className="approval-pin-note">{t("pinHandoffNote")}</div>
    </div>
  );
}
