import React from "react";
import { Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

const ICONS = { info: Info, warn: AlertTriangle, success: CheckCircle2, error: XCircle };

/** Inline info / warning / success / error box. role=status (or alert for errors) so feedback is announced. */
export default function Callout({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warn" | "success" | "error";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div className={`callout callout-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} className="callout-icon" aria-hidden />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children && <div className="callout-text">{children}</div>}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}
