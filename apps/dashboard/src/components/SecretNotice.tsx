import React from "react";
import { Lock } from "lucide-react";
import { useT } from "../i18n";
import { threeThings } from "../i18n/strings/threeThings";
import "../styles/threeThings.css";

/**
 * SPEC-v0.5 §1 — amber "secret" styling for anything showing a MoneyKey
 * (mk_live_…): lock icon + "Secret: whoever has it can spend within its
 * limits, don't send it to sellers". Wrap the key display in it:
 *
 *   <SecretNotice><code>{key}</code> <CopyButton text={key}/></SecretNotice>
 */
export default function SecretNotice({ children, compact = false }: { children?: React.ReactNode; compact?: boolean }) {
  const t = useT(threeThings);
  return (
    <div className={`secret-notice ${compact ? "compact" : ""}`}>
      <div className="secret-notice-head">
        <span className="secret-badge">
          <Lock size={12} aria-hidden /> {t("secretBadge")}
        </span>
        <span className="secret-notice-title">{t("secretNoticeTitle")}</span>
      </div>
      {children && <div className="secret-notice-content">{children}</div>}
      {!compact && <div className="secret-notice-body">{t("secretNoticeBody")}</div>}
    </div>
  );
}
