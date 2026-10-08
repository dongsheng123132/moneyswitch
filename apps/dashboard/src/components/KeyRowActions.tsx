import React from "react";
import { Ellipsis } from "lucide-react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { keysStrings } from "../i18n/strings/keys";
import { skillStrings } from "../i18n/strings/skill";

/**
 * Row actions of the Money Keys list: "Reset secret and copy skill" and Revoke
 * (with its inline confirmation). Only an active key gets them; a revoked,
 * expired or ancestor-disabled key is already dead for good (no un-revoke, no
 * new secret, SPEC-v0.4 §A), so its cell stays empty. A root key also gets
 * "Set confirmation code" (its approval PIN, SPEC.md §3); a child key has none.
 */
export default function KeyRowActions({
  status,
  childrenCount,
  confirmingRevoke,
  revoking,
  onRotate,
  onSetPin,
  onAskRevoke,
  onRevoke,
  onCancelRevoke,
  compact = false,
}: {
  status: string;
  childrenCount: number;
  confirmingRevoke: boolean;
  revoking: boolean;
  onRotate: () => void;
  /** Only a root key has an approval PIN to set. */
  onSetPin?: () => void;
  onAskRevoke: () => void;
  onRevoke: () => void;
  onCancelRevoke: () => void;
  compact?: boolean;
}) {
  const t = useT(keysStrings);
  const ts = useT(skillStrings);
  const tc = useT(common);
  if (status !== "active") return null;
  const actions = (
    <div className="keys-row-actions">
      <button type="button" className="btn small secondary" onClick={onRotate}>
        {ts("rotateBtn")}
      </button>
      {onSetPin && (
        <button type="button" className="btn small secondary" onClick={onSetPin}>
          {t("pinSetBtn")}
        </button>
      )}
      {confirmingRevoke ? (
        <div className="keys-revoke-confirm">
          <span>{childrenCount > 0 ? t("revokeConfirmTextWithChildren", { n: childrenCount }) : t("revokeConfirmText")}</span>
          <button type="button" className="btn small danger" onClick={onRevoke} disabled={revoking}>
            {revoking ? "…" : t("revokeBtn")}
          </button>
          <button type="button" className="btn small secondary" onClick={onCancelRevoke}>
            {tc("cancel")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn small danger" onClick={onAskRevoke}>
          {t("revokeBtn")}
        </button>
      )}
    </div>
  );
  if (!compact) return actions;
  return (
    <details className="key-actions-menu">
      <summary aria-label={t("moreActions")} title={t("moreActions")}><Ellipsis size={18} aria-hidden="true" /></summary>
      {actions}
    </details>
  );
}
