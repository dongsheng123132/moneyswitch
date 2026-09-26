import React from "react";
import Pill from "./Pill";
import Term from "./Term";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

export type PaymentStatus = "reserved" | "settled" | "failed" | "unknown";

const TONE: Record<PaymentStatus, "green" | "red" | "blue" | "yellow"> = {
  settled: "green",
  failed: "red",
  reserved: "blue",
  unknown: "yellow",
};

/**
 * Localized payment status + hover explanation + MOCK marker (docs/ux-audit.md B-4).
 *
 * v0.5: a `failed` row whose error_code is NOT_SETTLED_EXPIRED means the
 * seller never settled and the buyer's payment authorization expired unused
 * (confirmed on-chain by reconcileUnknownPayments) — shown distinctly from a
 * generic failure so it's clear the reserved quota was released, not lost.
 */
export default function StatusPill({
  status,
  mock,
  errorCode,
}: {
  status: PaymentStatus;
  mock?: boolean;
  errorCode?: string | null;
}) {
  const t = useT(common);
  const isNotSettledExpired = status === "failed" && errorCode === "NOT_SETTLED_EXPIRED";
  const termKey = isNotSettledExpired ? "status_failed_not_settled_expired" : (`status_${status}` as const);
  return (
    <span className="status-cell">
      <Term k={termKey}>
        <Pill tone={isNotSettledExpired ? "yellow" : TONE[status] ?? "gray"}>{t(termKey)}</Pill>
      </Term>
      {mock && (
        <Term k="mock">
          <span className="badge mock">{t("mock")}</span>
        </Term>
      )}
    </span>
  );
}
